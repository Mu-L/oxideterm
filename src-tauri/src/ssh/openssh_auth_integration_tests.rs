use std::ffi::{OsStr, OsString};
use std::fs;
use std::net::TcpListener as StdTcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::OnceLock;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use tempfile::TempDir;
use tokio::sync::Mutex;
use tokio::time::sleep;

use super::client::SshClient;
use super::config::{AuthMethod, SshConfig};

const TEST_TIMEOUT_SECS: u64 = 10;

#[derive(Clone)]
struct OpenSshBinaries {
    sshd: PathBuf,
    ssh_agent: PathBuf,
    ssh_add: PathBuf,
    ssh_keygen: PathBuf,
}

struct RunningProcess {
    child: Child,
}

impl RunningProcess {
    fn spawn(command: &mut Command, label: &str) -> Result<Self> {
        let child = command
            .spawn()
            .with_context(|| format!("failed to spawn {label}"))?;
        Ok(Self { child })
    }
}

impl Drop for RunningProcess {
    fn drop(&mut self) {
        if let Ok(None) = self.child.try_wait() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

struct OpenSshServer {
    _dir: TempDir,
    log_path: PathBuf,
    port: u16,
    _process: RunningProcess,
}

struct AgentEnvironment {
    _dir: TempDir,
    _socket_path: PathBuf,
    _process: RunningProcess,
    _env_guard: EnvVarGuard,
}

struct CertificateMaterial {
    _dir: TempDir,
    key_path: PathBuf,
    cert_path: PathBuf,
}

struct EnvVarGuard {
    key: &'static str,
    previous: Option<OsString>,
}

impl EnvVarGuard {
    fn set(key: &'static str, value: &OsStr) -> Self {
        let previous = std::env::var_os(key);
        unsafe {
            std::env::set_var(key, value);
        }
        Self { key, previous }
    }
}

impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        unsafe {
            if let Some(previous) = &self.previous {
                std::env::set_var(self.key, previous);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }
}

fn ssh_env_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn find_binary(name: &str, fallbacks: &[&str]) -> Option<PathBuf> {
    let path_env = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_env) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    fallbacks
        .iter()
        .map(PathBuf::from)
        .find(|candidate| candidate.is_file())
}

fn detect_openssh_binaries() -> Option<OpenSshBinaries> {
    Some(OpenSshBinaries {
        sshd: find_binary("sshd", &["/usr/sbin/sshd", "/usr/local/sbin/sshd"] )?,
        ssh_agent: find_binary("ssh-agent", &["/usr/bin/ssh-agent", "/usr/local/bin/ssh-agent"] )?,
        ssh_add: find_binary("ssh-add", &["/usr/bin/ssh-add", "/usr/local/bin/ssh-add"] )?,
        ssh_keygen: find_binary("ssh-keygen", &["/usr/bin/ssh-keygen", "/usr/local/bin/ssh-keygen"] )?,
    })
}

fn run_command(command: &mut Command, label: &str) -> Result<()> {
    let output = command
        .output()
        .with_context(|| format!("failed to run {label}"))?;
    if output.status.success() {
        return Ok(());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    bail!("{label} failed: stdout={stdout:?} stderr={stderr:?}")
}

fn reserve_local_port() -> Result<u16> {
    let listener = StdTcpListener::bind(("127.0.0.1", 0)).context("failed to reserve local port")?;
    let port = listener.local_addr().context("failed to inspect reserved port")?.port();
    drop(listener);
    Ok(port)
}

async fn wait_for_tcp_listener(port: u16, label: &str, log_path: &Path) -> Result<()> {
    for _ in 0..50 {
        if tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            return Ok(());
        }
        sleep(Duration::from_millis(100)).await;
    }

    let log = fs::read_to_string(log_path).unwrap_or_else(|_| "<log unavailable>".to_string());
    bail!("{label} did not start listening on port {port}. sshd log: {log}")
}

async fn wait_for_socket(path: &Path, label: &str) -> Result<()> {
    for _ in 0..50 {
        if path.exists() {
            return Ok(());
        }
        sleep(Duration::from_millis(100)).await;
    }
    bail!("{label} did not create socket at {}", path.display())
}

fn generate_rsa_keypair(ssh_keygen: &Path, dir: &Path, basename: &str) -> Result<PathBuf> {
    let key_path = dir.join(basename);
    run_command(
        Command::new(ssh_keygen)
            .arg("-q")
            .arg("-t")
            .arg("rsa")
            .arg("-b")
            .arg("3072")
            .arg("-N")
            .arg("")
            .arg("-f")
            .arg(&key_path),
        &format!("ssh-keygen for {}", key_path.display()),
    )?;
    Ok(key_path)
}

fn generate_ed25519_keypair(ssh_keygen: &Path, dir: &Path, basename: &str) -> Result<PathBuf> {
    let key_path = dir.join(basename);
    run_command(
        Command::new(ssh_keygen)
            .arg("-q")
            .arg("-t")
            .arg("ed25519")
            .arg("-N")
            .arg("")
            .arg("-f")
            .arg(&key_path),
        &format!("ssh-keygen for {}", key_path.display()),
    )?;
    Ok(key_path)
}

fn write_sshd_config(
    dir: &Path,
    username: &str,
    port: u16,
    host_key: &Path,
    authorized_keys: &Path,
    trusted_ca: Option<&Path>,
    principals_file: Option<&Path>,
    accepted_algorithms: &str,
) -> Result<PathBuf> {
    let config_path = dir.join("sshd_config");
    let pid_path = dir.join("sshd.pid");
    let mut config = format!(
        "Port {port}\nListenAddress 127.0.0.1\nHostKey {}\nPidFile {}\nAuthorizedKeysFile {}\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nChallengeResponseAuthentication no\nPubkeyAuthentication yes\nUsePAM no\nStrictModes no\nPermitRootLogin no\nAllowUsers {username}\nLogLevel DEBUG3\nPubkeyAcceptedAlgorithms {accepted_algorithms}\nSubsystem sftp internal-sftp\n",
        host_key.display(),
        pid_path.display(),
        authorized_keys.display(),
    );

    if let Some(trusted_ca) = trusted_ca {
        config.push_str(&format!("TrustedUserCAKeys {}\n", trusted_ca.display()));
    }
    if let Some(principals_file) = principals_file {
        config.push_str(&format!(
            "AuthorizedPrincipalsFile {}\n",
            principals_file.display()
        ));
    }

    fs::write(&config_path, config).context("failed to write sshd_config")?;
    Ok(config_path)
}

async fn start_sshd(
    binaries: &OpenSshBinaries,
    username: &str,
    accepted_algorithms: &str,
    authorized_keys_contents: &str,
    trusted_ca: Option<&Path>,
    principals_file: Option<&Path>,
) -> Result<OpenSshServer> {
    let dir = tempfile::tempdir().context("failed to create sshd tempdir")?;
    let host_key = generate_ed25519_keypair(&binaries.ssh_keygen, dir.path(), "ssh_host_ed25519_key")?;
    let authorized_keys = dir.path().join("authorized_keys");
    fs::write(&authorized_keys, authorized_keys_contents).context("failed to write authorized_keys")?;
    let port = reserve_local_port()?;
    let config_path = write_sshd_config(
        dir.path(),
        username,
        port,
        &host_key,
        &authorized_keys,
        trusted_ca,
        principals_file,
        accepted_algorithms,
    )?;
    let log_path = dir.path().join("sshd.log");

    let process = RunningProcess::spawn(
        Command::new(&binaries.sshd)
            .arg("-D")
            .arg("-f")
            .arg(&config_path)
            .arg("-E")
            .arg(&log_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null()),
        "sshd",
    )?;

    wait_for_tcp_listener(port, "sshd", &log_path).await?;

    Ok(OpenSshServer {
        _dir: dir,
        log_path,
        port,
        _process: process,
    })
}

async fn start_ssh_agent(binaries: &OpenSshBinaries, key_path: &Path) -> Result<AgentEnvironment> {
    let dir = tempfile::tempdir().context("failed to create ssh-agent tempdir")?;
    let socket_path = dir.path().join("agent.sock");
    let process = RunningProcess::spawn(
        Command::new(&binaries.ssh_agent)
            .arg("-D")
            .arg("-a")
            .arg(&socket_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null()),
        "ssh-agent",
    )?;

    wait_for_socket(&socket_path, "ssh-agent").await?;

    run_command(
        Command::new(&binaries.ssh_add)
            .env("SSH_AUTH_SOCK", &socket_path)
            .arg(key_path),
        "ssh-add",
    )?;

    Ok(AgentEnvironment {
        _dir: dir,
        _socket_path: socket_path.clone(),
        _process: process,
        _env_guard: EnvVarGuard::set("SSH_AUTH_SOCK", socket_path.as_os_str()),
    })
}

fn generate_certificate_material(
    binaries: &OpenSshBinaries,
    username: &str,
) -> Result<(CertificateMaterial, PathBuf)> {
    let dir = tempfile::tempdir().context("failed to create certificate tempdir")?;
    let ca_key = generate_ed25519_keypair(&binaries.ssh_keygen, dir.path(), "ca_user")?;
    let key_path = generate_rsa_keypair(&binaries.ssh_keygen, dir.path(), "id_rsa")?;

    run_command(
        Command::new(&binaries.ssh_keygen)
            .arg("-q")
            .arg("-s")
            .arg(&ca_key)
            .arg("-I")
            .arg("oxideterm-rsa-cert")
            .arg("-n")
            .arg(username)
            .arg("-V")
            .arg("-1m:+10m")
            .arg(key_path.with_extension("pub")),
        "ssh-keygen certificate signing",
    )?;

    let cert_path = dir.path().join("id_rsa-cert.pub");
    Ok((
        CertificateMaterial {
            _dir: dir,
            key_path,
            cert_path,
        },
        ca_key.with_extension("pub"),
    ))
}

fn openssh_client_config(port: u16, username: &str, auth: AuthMethod) -> SshConfig {
    SshConfig {
        host: "127.0.0.1".to_string(),
        port,
        username: username.to_string(),
        auth,
        timeout_secs: TEST_TIMEOUT_SECS,
        cols: 80,
        rows: 24,
        proxy_chain: None,
        strict_host_key_checking: false,
        trust_host_key: Some(false),
        agent_forwarding: false,
    }
}

fn cert_accepted_algorithms(hash_name: &str) -> String {
    format!(
        "{hash_name},{hash_name}-cert-v01@openssh.com"
    )
}

fn test_username() -> String {
    whoami::username()
}

fn require_openssh() -> Option<OpenSshBinaries> {
    detect_openssh_binaries()
}

#[tokio::test]
async fn test_agent_auth_against_rsa_sha2_256_only_openssh_server() -> Result<()> {
    let Some(binaries) = require_openssh() else {
        eprintln!("skipping OpenSSH agent integration test: required binaries not found");
        return Ok(());
    };

    let _env_lock = ssh_env_lock().lock().await;
    let username = test_username();
    let key_dir = tempfile::tempdir().context("failed to create RSA key tempdir")?;
    let key_path = generate_rsa_keypair(&binaries.ssh_keygen, key_dir.path(), "id_rsa_agent")?;
    let public_key = fs::read_to_string(key_path.with_extension("pub"))
        .context("failed to read RSA public key")?;
    let server = start_sshd(
        &binaries,
        &username,
        "rsa-sha2-256",
        &public_key,
        None,
        None,
    )
    .await?;
    let agent = start_ssh_agent(&binaries, &key_path).await?;

    let session = SshClient::new(openssh_client_config(server.port, &username, AuthMethod::Agent))
        .connect(None)
        .await
        .with_context(|| {
            format!(
                "agent auth against rsa-sha2-256-only server failed; sshd log: {}",
                fs::read_to_string(&server.log_path).unwrap_or_default()
            )
        })?;

    drop(session);
    drop(agent);
    drop(server);
    Ok(())
}

#[tokio::test]
async fn test_agent_auth_against_rsa_sha2_512_only_openssh_server() -> Result<()> {
    let Some(binaries) = require_openssh() else {
        eprintln!("skipping OpenSSH agent integration test: required binaries not found");
        return Ok(());
    };

    let _env_lock = ssh_env_lock().lock().await;
    let username = test_username();
    let key_dir = tempfile::tempdir().context("failed to create RSA key tempdir")?;
    let key_path = generate_rsa_keypair(&binaries.ssh_keygen, key_dir.path(), "id_rsa_agent")?;
    let public_key = fs::read_to_string(key_path.with_extension("pub"))
        .context("failed to read RSA public key")?;
    let server = start_sshd(
        &binaries,
        &username,
        "rsa-sha2-512",
        &public_key,
        None,
        None,
    )
    .await?;
    let agent = start_ssh_agent(&binaries, &key_path).await?;

    let session = SshClient::new(openssh_client_config(server.port, &username, AuthMethod::Agent))
        .connect(None)
        .await
        .with_context(|| {
            format!(
                "agent auth against rsa-sha2-512-only server failed; sshd log: {}",
                fs::read_to_string(&server.log_path).unwrap_or_default()
            )
        })?;

    drop(session);
    drop(agent);
    drop(server);
    Ok(())
}

#[tokio::test]
async fn test_certificate_auth_against_rsa_sha2_256_only_openssh_server() -> Result<()> {
    let Some(binaries) = require_openssh() else {
        eprintln!("skipping OpenSSH certificate integration test: required binaries not found");
        return Ok(());
    };

    let username = test_username();
    let (cert_material, ca_public_key) = generate_certificate_material(&binaries, &username)?;
    let principals_dir = tempfile::tempdir().context("failed to create principals tempdir")?;
    let principals_file = principals_dir.path().join("authorized_principals");
    fs::write(&principals_file, format!("{username}\n")).context("failed to write principals file")?;

    let server = start_sshd(
        &binaries,
        &username,
        &cert_accepted_algorithms("rsa-sha2-256"),
        "",
        Some(&ca_public_key),
        Some(&principals_file),
    )
    .await?;

    let session = SshClient::new(openssh_client_config(
        server.port,
        &username,
        AuthMethod::Certificate {
            key_path: cert_material.key_path.to_string_lossy().into_owned(),
            cert_path: cert_material.cert_path.to_string_lossy().into_owned(),
            passphrase: None,
        },
    ))
    .connect(None)
    .await
    .with_context(|| {
        format!(
            "certificate auth against rsa-sha2-256-only server failed; sshd log: {}",
            fs::read_to_string(&server.log_path).unwrap_or_default()
        )
    })?;

    drop(session);
    drop(server);
    Ok(())
}

#[tokio::test]
async fn test_certificate_auth_against_rsa_sha2_512_only_openssh_server() -> Result<()> {
    let Some(binaries) = require_openssh() else {
        eprintln!("skipping OpenSSH certificate integration test: required binaries not found");
        return Ok(());
    };

    let username = test_username();
    let (cert_material, ca_public_key) = generate_certificate_material(&binaries, &username)?;
    let principals_dir = tempfile::tempdir().context("failed to create principals tempdir")?;
    let principals_file = principals_dir.path().join("authorized_principals");
    fs::write(&principals_file, format!("{username}\n")).context("failed to write principals file")?;

    let server = start_sshd(
        &binaries,
        &username,
        &cert_accepted_algorithms("rsa-sha2-512"),
        "",
        Some(&ca_public_key),
        Some(&principals_file),
    )
    .await?;

    let session = SshClient::new(openssh_client_config(
        server.port,
        &username,
        AuthMethod::Certificate {
            key_path: cert_material.key_path.to_string_lossy().into_owned(),
            cert_path: cert_material.cert_path.to_string_lossy().into_owned(),
            passphrase: None,
        },
    ))
    .connect(None)
    .await
    .with_context(|| {
        format!(
            "certificate auth against rsa-sha2-512-only server failed; sshd log: {}",
            fs::read_to_string(&server.log_path).unwrap_or_default()
        )
    })?;

    drop(session);
    drop(server);
    Ok(())
}