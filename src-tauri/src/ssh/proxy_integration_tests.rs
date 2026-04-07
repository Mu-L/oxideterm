use std::net::SocketAddr;
#[cfg(unix)]
use std::path::PathBuf;
use std::sync::Arc;
#[cfg(unix)]
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rand::rngs::OsRng;
use russh::keys::ssh_key::LineEnding;
use russh::keys::ssh_key::certificate::{Builder as CertificateBuilder, CertType};
use russh::keys::{Algorithm, Certificate, PrivateKey, PublicKey};
use russh::server;
use tempfile::TempDir;
use tokio::io::copy_bidirectional;
#[cfg(unix)]
use tokio::io::{AsyncReadExt, AsyncWriteExt};
#[cfg(unix)]
use tokio::net::UnixListener;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
#[cfg(unix)]
use tokio::sync::{Mutex, oneshot};
use tokio::task::JoinHandle;

use super::client::SshClient;
use super::config::AuthMethod;
use super::config::SshConfig;
use super::error::SshError;
use super::proxy::{ProxyChain, ProxyHop, connect_via_proxy};
use crate::session::tree::MAX_CHAIN_DEPTH;
use zeroize::Zeroizing;

const TEST_TIMEOUT_SECS: u64 = 10;

#[derive(Clone)]
enum AllowedAuth {
    Password {
        username: String,
        password: String,
    },
    PublicKey {
        username: String,
        public_key: PublicKey,
    },
    Certificate {
        username: String,
    },
}

struct TestSshServer {
    addr: SocketAddr,
    shutdown_tx: watch::Sender<bool>,
    accept_task: JoinHandle<()>,
}

impl TestSshServer {
    async fn start(auth: AllowedAuth, allow_direct_tcpip: bool) -> Self {
        Self::start_internal(auth, allow_direct_tcpip, None).await
    }

    #[cfg(unix)]
    async fn start_with_agent_forward_test(
        auth: AllowedAuth,
        allow_direct_tcpip: bool,
        request: Vec<u8>,
        expected_response_len: usize,
    ) -> (Self, oneshot::Receiver<Result<Vec<u8>, String>>) {
        let (result_tx, result_rx) = oneshot::channel();
        let state = Arc::new(AgentForwardTestState {
            request,
            expected_response_len,
            result_tx: Mutex::new(Some(result_tx)),
        });

        (
            Self::start_internal(auth, allow_direct_tcpip, Some(state)).await,
            result_rx,
        )
    }

    async fn start_internal(
        auth: AllowedAuth,
        allow_direct_tcpip: bool,
        #[cfg(unix)] agent_forward_test: Option<Arc<AgentForwardTestState>>,
        #[cfg(not(unix))] _agent_forward_test: Option<()>,
    ) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let config = Arc::new(server::Config {
            auth_rejection_time: Duration::from_millis(1),
            auth_rejection_time_initial: Some(Duration::from_millis(0)),
            inactivity_timeout: Some(Duration::from_secs(30)),
            keys: vec![PrivateKey::random(&mut OsRng, Algorithm::Ed25519).unwrap()],
            ..Default::default()
        });
        let (shutdown_tx, mut shutdown_rx) = watch::channel(false);

        let accept_task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    changed = shutdown_rx.changed() => {
                        if changed.is_err() || *shutdown_rx.borrow() {
                            break;
                        }
                    }
                    accept = listener.accept() => {
                        let Ok((socket, _peer_addr)) = accept else {
                            break;
                        };

                        let handler = TestServerHandler {
                            auth: auth.clone(),
                            allow_direct_tcpip,
                            #[cfg(unix)]
                            agent_forward_test: agent_forward_test.clone(),
                        };
                        let config = Arc::clone(&config);
                        tokio::spawn(async move {
                            if let Ok(session) = server::run_stream(config, socket, handler).await {
                                let _ = session.await;
                            }
                        });
                    }
                }
            }
        });

        tokio::task::yield_now().await;

        Self {
            addr,
            shutdown_tx,
            accept_task,
        }
    }

    fn port(&self) -> u16 {
        self.addr.port()
    }
}

impl Drop for TestSshServer {
    fn drop(&mut self) {
        let _ = self.shutdown_tx.send(true);
        self.accept_task.abort();
    }
}

struct TestServerHandler {
    auth: AllowedAuth,
    allow_direct_tcpip: bool,
    #[cfg(unix)]
    agent_forward_test: Option<Arc<AgentForwardTestState>>,
}

impl TestServerHandler {
    fn password_accepts(&self, user: &str, password: &str) -> bool {
        matches!(
            &self.auth,
            AllowedAuth::Password { username, password: expected }
                if username == user && expected == password
        )
    }

    fn public_key_accepts(&self, user: &str, public_key: &PublicKey) -> bool {
        match &self.auth {
            AllowedAuth::PublicKey {
                username,
                public_key: expected,
            } => username == user && expected == public_key,
            AllowedAuth::Certificate { username } => username == user,
            AllowedAuth::Password { .. } => false,
        }
    }

    fn certificate_accepts(&self, user: &str, _certificate: &Certificate) -> bool {
        matches!(&self.auth, AllowedAuth::Certificate { username } if username == user)
    }
}

impl server::Handler for TestServerHandler {
    type Error = russh::Error;

    async fn channel_open_session(
        &mut self,
        _channel: russh::Channel<server::Msg>,
        _session: &mut server::Session,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }

    async fn auth_password(
        &mut self,
        user: &str,
        password: &str,
    ) -> Result<server::Auth, Self::Error> {
        if self.password_accepts(user, password) {
            Ok(server::Auth::Accept)
        } else {
            Ok(server::Auth::reject())
        }
    }

    async fn auth_publickey_offered(
        &mut self,
        user: &str,
        public_key: &PublicKey,
    ) -> Result<server::Auth, Self::Error> {
        if self.public_key_accepts(user, public_key) {
            Ok(server::Auth::Accept)
        } else {
            Ok(server::Auth::reject())
        }
    }

    async fn auth_publickey(
        &mut self,
        user: &str,
        public_key: &PublicKey,
    ) -> Result<server::Auth, Self::Error> {
        if self.public_key_accepts(user, public_key) {
            Ok(server::Auth::Accept)
        } else {
            Ok(server::Auth::reject())
        }
    }

    async fn auth_openssh_certificate(
        &mut self,
        user: &str,
        certificate: &Certificate,
    ) -> Result<server::Auth, Self::Error> {
        if self.certificate_accepts(user, certificate) {
            Ok(server::Auth::Accept)
        } else {
            Ok(server::Auth::reject())
        }
    }

    async fn channel_open_direct_tcpip(
        &mut self,
        channel: russh::Channel<server::Msg>,
        host_to_connect: &str,
        port_to_connect: u32,
        _originator_address: &str,
        _originator_port: u32,
        _session: &mut server::Session,
    ) -> Result<bool, Self::Error> {
        if !self.allow_direct_tcpip {
            return Ok(false);
        }

        let host = host_to_connect.to_string();
        tokio::spawn(async move {
            let Ok(mut upstream) =
                TcpStream::connect((host.as_str(), port_to_connect as u16)).await
            else {
                return;
            };
            let mut channel_stream = channel.into_stream();
            let _ = copy_bidirectional(&mut channel_stream, &mut upstream).await;
        });

        Ok(true)
    }

    #[cfg(unix)]
    async fn agent_request(
        &mut self,
        channel: russh::ChannelId,
        session: &mut server::Session,
    ) -> Result<bool, Self::Error> {
        if self.agent_forward_test.is_some() {
            let _ = session.channel_success(channel);
            Ok(true)
        } else {
            Ok(false)
        }
    }

    #[cfg(unix)]
    async fn shell_request(
        &mut self,
        _channel: russh::ChannelId,
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        let Some(agent_forward_test) = self.agent_forward_test.clone() else {
            return Ok(());
        };
        let handle = session.handle();

        tokio::spawn(async move {
            let mut agent_channel = match handle.channel_open_agent().await {
                Ok(channel) => channel,
                Err(error) => {
                    agent_forward_test
                        .send_result(Err(format!("failed to open agent channel: {error}")))
                        .await;
                    return;
                }
            };

            if let Err(error) = agent_channel
                .data(agent_forward_test.request.as_slice())
                .await
            {
                agent_forward_test
                    .send_result(Err(format!("failed to write to agent channel: {error}")))
                    .await;
                return;
            }

            let mut received = Vec::new();
            loop {
                match tokio::time::timeout(
                    Duration::from_secs(TEST_TIMEOUT_SECS),
                    agent_channel.wait(),
                )
                .await
                {
                    Ok(Some(russh::ChannelMsg::Data { data })) => {
                        received.extend_from_slice(&data);
                        if received.len() >= agent_forward_test.expected_response_len {
                            let _ = agent_channel.eof().await;
                            agent_forward_test.send_result(Ok(received)).await;
                            return;
                        }
                    }
                    Ok(Some(russh::ChannelMsg::ExtendedData { data, ext })) if ext == 1 => {
                        received.extend_from_slice(&data);
                        if received.len() >= agent_forward_test.expected_response_len {
                            let _ = agent_channel.eof().await;
                            agent_forward_test.send_result(Ok(received)).await;
                            return;
                        }
                    }
                    Ok(Some(russh::ChannelMsg::Eof | russh::ChannelMsg::Close)) => {
                        agent_forward_test
                            .send_result(Err(
                                "agent channel closed before response completed".to_string()
                            ))
                            .await;
                        return;
                    }
                    Ok(Some(_)) => {}
                    Ok(None) => {
                        agent_forward_test
                            .send_result(Err(
                                "agent channel ended before response completed".to_string()
                            ))
                            .await;
                        return;
                    }
                    Err(_) => {
                        agent_forward_test
                            .send_result(Err("timed out waiting for agent response".to_string()))
                            .await;
                        return;
                    }
                }
            }
        });

        Ok(())
    }
}

#[cfg(unix)]
struct AgentForwardTestState {
    request: Vec<u8>,
    expected_response_len: usize,
    result_tx: Mutex<Option<oneshot::Sender<Result<Vec<u8>, String>>>>,
}

#[cfg(unix)]
impl AgentForwardTestState {
    async fn send_result(&self, result: Result<Vec<u8>, String>) {
        if let Some(result_tx) = self.result_tx.lock().await.take() {
            let _ = result_tx.send(result);
        }
    }
}

#[cfg(unix)]
struct FakeAgentServer {
    _dir: TempDir,
    socket_path: PathBuf,
    received_rx: oneshot::Receiver<Vec<u8>>,
    task: JoinHandle<()>,
}

#[cfg(unix)]
impl FakeAgentServer {
    async fn start(expected_request_len: usize, response: Vec<u8>) -> Self {
        let dir = tempfile::Builder::new()
            .prefix("oxide-agent-test-")
            .tempdir_in(std::env::temp_dir())
            .unwrap();
        let socket_path = dir.path().join("agent.sock");
        let listener = UnixListener::bind(&socket_path).unwrap();
        let (received_tx, received_rx) = oneshot::channel();

        let task = tokio::spawn(async move {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };

            let mut request = vec![0; expected_request_len];
            if stream.read_exact(&mut request).await.is_err() {
                return;
            }
            let _ = received_tx.send(request);
            let _ = stream.write_all(&response).await;
            let _ = stream.shutdown().await;
        });

        Self {
            _dir: dir,
            socket_path,
            received_rx,
            task,
        }
    }
}

#[cfg(unix)]
struct EnvVarGuard {
    key: &'static str,
    previous: Option<std::ffi::OsString>,
}

#[cfg(unix)]
impl EnvVarGuard {
    fn set(key: &'static str, value: &std::ffi::OsStr) -> Self {
        let previous = std::env::var_os(key);
        unsafe {
            std::env::set_var(key, value);
        }
        Self { key, previous }
    }
}

#[cfg(unix)]
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

#[cfg(unix)]
fn agent_env_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

struct KeyMaterialFiles {
    _dir: TempDir,
    key_path: String,
    public_key: PublicKey,
}

struct CertificateMaterialFiles {
    _dir: TempDir,
    key_path: String,
    cert_path: String,
}

fn generate_key_files() -> KeyMaterialFiles {
    let temp_dir = TempDir::new().unwrap();
    let key_path = temp_dir.path().join("id_ed25519");
    let private_key = PrivateKey::random(&mut OsRng, Algorithm::Ed25519).unwrap();
    let public_key = private_key.public_key().clone();
    private_key
        .write_openssh_file(&key_path, LineEnding::LF)
        .unwrap();

    KeyMaterialFiles {
        _dir: temp_dir,
        key_path: key_path.to_string_lossy().into_owned(),
        public_key,
    }
}

fn generate_certificate_files(username: &str) -> CertificateMaterialFiles {
    let temp_dir = TempDir::new().unwrap();
    let key_path = temp_dir.path().join("id_ed25519");
    let cert_path = temp_dir.path().join("id_ed25519-cert.pub");

    let ca_key = PrivateKey::random(&mut OsRng, Algorithm::Ed25519).unwrap();
    let subject_key = PrivateKey::random(&mut OsRng, Algorithm::Ed25519).unwrap();
    subject_key
        .write_openssh_file(&key_path, LineEnding::LF)
        .unwrap();

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let mut builder = CertificateBuilder::new_with_random_nonce(
        &mut OsRng,
        subject_key.public_key().clone(),
        now.saturating_sub(60),
        now + 3600,
    )
    .unwrap();
    builder.serial(1).unwrap();
    builder.cert_type(CertType::User).unwrap();
    builder.key_id(format!("{}-cert", username)).unwrap();
    builder.valid_principal(username).unwrap();
    builder
        .comment(format!("{}@oxideterm.test", username))
        .unwrap();
    let cert = builder.sign(&ca_key).unwrap();
    std::fs::write(&cert_path, cert.to_string()).unwrap();

    CertificateMaterialFiles {
        _dir: temp_dir,
        key_path: key_path.to_string_lossy().into_owned(),
        cert_path: cert_path.to_string_lossy().into_owned(),
    }
}

fn password_auth(password: &str) -> AuthMethod {
    AuthMethod::Password {
        password: Zeroizing::new(password.to_string()),
    }
}

fn key_auth(key_path: &str) -> AuthMethod {
    AuthMethod::Key {
        key_path: key_path.to_string(),
        passphrase: None,
    }
}

fn certificate_auth(key_path: &str, cert_path: &str) -> AuthMethod {
    AuthMethod::Certificate {
        key_path: key_path.to_string(),
        cert_path: cert_path.to_string(),
        passphrase: None,
    }
}

fn jump_hop(host: &str, port: u16, username: &str, auth: AuthMethod) -> ProxyHop {
    ProxyHop {
        host: host.to_string(),
        port,
        username: username.to_string(),
        auth,
    }
}

#[tokio::test]
async fn test_proxy_one_hop_password_to_password() {
    let target = TestSshServer::start(
        AllowedAuth::Password {
            username: "target-user".to_string(),
            password: "target-pass".to_string(),
        },
        false,
    )
    .await;
    let jump = TestSshServer::start(
        AllowedAuth::Password {
            username: "jump-user".to_string(),
            password: "jump-pass".to_string(),
        },
        true,
    )
    .await;

    let chain = ProxyChain::new().add_hop(jump_hop(
        "127.0.0.1",
        jump.port(),
        "jump-user",
        password_auth("jump-pass"),
    ));

    let connection = connect_via_proxy(
        &chain,
        "127.0.0.1",
        target.port(),
        "target-user",
        &password_auth("target-pass"),
        TEST_TIMEOUT_SECS,
    )
    .await
    .unwrap();

    assert_eq!(connection.jump_handles.len(), 1);
}

#[tokio::test]
async fn test_proxy_one_hop_key_to_password() {
    let jump_key = generate_key_files();
    let target = TestSshServer::start(
        AllowedAuth::Password {
            username: "target-user".to_string(),
            password: "target-pass".to_string(),
        },
        false,
    )
    .await;
    let jump = TestSshServer::start(
        AllowedAuth::PublicKey {
            username: "jump-user".to_string(),
            public_key: jump_key.public_key.clone(),
        },
        true,
    )
    .await;

    let chain = ProxyChain::new().add_hop(jump_hop(
        "127.0.0.1",
        jump.port(),
        "jump-user",
        key_auth(&jump_key.key_path),
    ));

    let connection = connect_via_proxy(
        &chain,
        "127.0.0.1",
        target.port(),
        "target-user",
        &password_auth("target-pass"),
        TEST_TIMEOUT_SECS,
    )
    .await
    .unwrap();

    assert_eq!(connection.jump_handles.len(), 1);
}

#[tokio::test]
async fn test_proxy_one_hop_certificate_to_password() {
    let jump_cert = generate_certificate_files("jump-user");
    let target = TestSshServer::start(
        AllowedAuth::Password {
            username: "target-user".to_string(),
            password: "target-pass".to_string(),
        },
        false,
    )
    .await;
    let jump = TestSshServer::start(
        AllowedAuth::Certificate {
            username: "jump-user".to_string(),
        },
        true,
    )
    .await;

    let chain = ProxyChain::new().add_hop(jump_hop(
        "127.0.0.1",
        jump.port(),
        "jump-user",
        certificate_auth(&jump_cert.key_path, &jump_cert.cert_path),
    ));

    let connection = connect_via_proxy(
        &chain,
        "127.0.0.1",
        target.port(),
        "target-user",
        &password_auth("target-pass"),
        TEST_TIMEOUT_SECS,
    )
    .await
    .unwrap();

    assert_eq!(connection.jump_handles.len(), 1);
}

#[tokio::test]
async fn test_proxy_two_hop_password_to_key_to_password() {
    let jump_two_key = generate_key_files();
    let target = TestSshServer::start(
        AllowedAuth::Password {
            username: "target-user".to_string(),
            password: "target-pass".to_string(),
        },
        false,
    )
    .await;
    let jump_two = TestSshServer::start(
        AllowedAuth::PublicKey {
            username: "jump-two-user".to_string(),
            public_key: jump_two_key.public_key.clone(),
        },
        true,
    )
    .await;
    let jump_one = TestSshServer::start(
        AllowedAuth::Password {
            username: "jump-one-user".to_string(),
            password: "jump-one-pass".to_string(),
        },
        true,
    )
    .await;

    let chain = ProxyChain::new()
        .add_hop(jump_hop(
            "127.0.0.1",
            jump_one.port(),
            "jump-one-user",
            password_auth("jump-one-pass"),
        ))
        .add_hop(jump_hop(
            "127.0.0.1",
            jump_two.port(),
            "jump-two-user",
            key_auth(&jump_two_key.key_path),
        ));

    let connection = connect_via_proxy(
        &chain,
        "127.0.0.1",
        target.port(),
        "target-user",
        &password_auth("target-pass"),
        TEST_TIMEOUT_SECS,
    )
    .await
    .unwrap();

    assert_eq!(connection.jump_handles.len(), 2);
}

#[tokio::test]
async fn test_proxy_two_hop_certificate_to_password_to_key() {
    let jump_one_cert = generate_certificate_files("jump-one-user");
    let target_key = generate_key_files();
    let target = TestSshServer::start(
        AllowedAuth::PublicKey {
            username: "target-user".to_string(),
            public_key: target_key.public_key.clone(),
        },
        false,
    )
    .await;
    let jump_two = TestSshServer::start(
        AllowedAuth::Password {
            username: "jump-two-user".to_string(),
            password: "jump-two-pass".to_string(),
        },
        true,
    )
    .await;
    let jump_one = TestSshServer::start(
        AllowedAuth::Certificate {
            username: "jump-one-user".to_string(),
        },
        true,
    )
    .await;

    let chain = ProxyChain::new()
        .add_hop(jump_hop(
            "127.0.0.1",
            jump_one.port(),
            "jump-one-user",
            certificate_auth(&jump_one_cert.key_path, &jump_one_cert.cert_path),
        ))
        .add_hop(jump_hop(
            "127.0.0.1",
            jump_two.port(),
            "jump-two-user",
            password_auth("jump-two-pass"),
        ));

    let connection = connect_via_proxy(
        &chain,
        "127.0.0.1",
        target.port(),
        "target-user",
        &key_auth(&target_key.key_path),
        TEST_TIMEOUT_SECS,
    )
    .await
    .unwrap();

    assert_eq!(connection.jump_handles.len(), 2);
}

#[tokio::test]
async fn test_proxy_reports_jump_auth_rejection() {
    let jump = TestSshServer::start(
        AllowedAuth::Password {
            username: "jump-user".to_string(),
            password: "correct-pass".to_string(),
        },
        true,
    )
    .await;
    let chain = ProxyChain::new().add_hop(jump_hop(
        "127.0.0.1",
        jump.port(),
        "jump-user",
        password_auth("wrong-pass"),
    ));

    let error = match connect_via_proxy(
        &chain,
        "127.0.0.1",
        65000,
        "target-user",
        &password_auth("target-pass"),
        TEST_TIMEOUT_SECS,
    )
    .await
    {
        Ok(_) => panic!("expected jump-hop authentication to fail"),
        Err(error) => error,
    };

    assert!(matches!(error, SshError::AuthenticationFailed(_)));
}

#[tokio::test]
async fn test_proxy_rejects_keyboard_interactive_hops() {
    let jump = TestSshServer::start(
        AllowedAuth::Password {
            username: "jump-user".to_string(),
            password: "jump-pass".to_string(),
        },
        true,
    )
    .await;
    let chain = ProxyChain::new().add_hop(jump_hop(
        "127.0.0.1",
        jump.port(),
        "jump-user",
        AuthMethod::KeyboardInteractive,
    ));

    let error = match connect_via_proxy(
        &chain,
        "127.0.0.1",
        65000,
        "target-user",
        &password_auth("target-pass"),
        TEST_TIMEOUT_SECS,
    )
    .await
    {
        Ok(_) => panic!("expected keyboard-interactive proxy hop to be rejected"),
        Err(error) => error,
    };

    assert!(
        error
            .to_string()
            .contains("KeyboardInteractive authentication not supported for proxy chain hops")
    );
}

#[tokio::test]
async fn test_proxy_chain_too_long_is_rejected_before_network() {
    let mut chain = ProxyChain::new();
    for index in 0..=MAX_CHAIN_DEPTH {
        chain = chain.add_hop(jump_hop(
            "127.0.0.1",
            2200 + index as u16,
            "jump-user",
            password_auth("jump-pass"),
        ));
    }

    let error = match connect_via_proxy(
        &chain,
        "127.0.0.1",
        22,
        "target-user",
        &password_auth("target-pass"),
        TEST_TIMEOUT_SECS,
    )
    .await
    {
        Ok(_) => panic!("expected overlong proxy chain to be rejected"),
        Err(error) => error,
    };

    assert!(matches!(error, SshError::ConnectionFailed(_)));
    assert!(error.to_string().contains("Proxy chain too long"));
}

#[tokio::test]
async fn test_proxy_certificate_material_failure_surfaces_in_real_chain_setup() {
    let jump = TestSshServer::start(
        AllowedAuth::Certificate {
            username: "jump-user".to_string(),
        },
        true,
    )
    .await;
    let key_files = generate_key_files();
    let invalid_cert_dir = TempDir::new().unwrap();
    let invalid_cert_path = invalid_cert_dir.path().join("invalid-cert.pub");
    std::fs::write(&invalid_cert_path, "not a certificate").unwrap();

    let chain = ProxyChain::new().add_hop(jump_hop(
        "127.0.0.1",
        jump.port(),
        "jump-user",
        certificate_auth(&key_files.key_path, &invalid_cert_path.to_string_lossy()),
    ));

    let error = match connect_via_proxy(
        &chain,
        "127.0.0.1",
        65000,
        "target-user",
        &password_auth("target-pass"),
        TEST_TIMEOUT_SECS,
    )
    .await
    {
        Ok(_) => panic!("expected invalid certificate material to fail before auth"),
        Err(error) => error,
    };

    assert!(matches!(error, SshError::CertificateParseError(_)));
}

#[cfg(unix)]
#[tokio::test]
async fn test_agent_forward_channel_relays_to_local_agent_socket() {
    let request = b"ping-from-remote-agent-channel".to_vec();
    let response = b"pong-from-local-fake-agent".to_vec();
    let fake_agent = FakeAgentServer::start(request.len(), response.clone()).await;
    let _env_lock = agent_env_lock().lock().await;
    let _env_guard = EnvVarGuard::set("SSH_AUTH_SOCK", fake_agent.socket_path.as_os_str());

    let (target, server_result_rx) = TestSshServer::start_with_agent_forward_test(
        AllowedAuth::Password {
            username: "target-user".to_string(),
            password: "target-pass".to_string(),
        },
        false,
        request.clone(),
        response.len(),
    )
    .await;

    let client = SshClient::new(SshConfig {
        host: "127.0.0.1".to_string(),
        port: target.port(),
        username: "target-user".to_string(),
        auth: password_auth("target-pass"),
        timeout_secs: TEST_TIMEOUT_SECS,
        cols: 80,
        rows: 24,
        proxy_chain: None,
        strict_host_key_checking: false,
        trust_host_key: Some(false),
        agent_forwarding: true,
    });

    let session = client.connect(None).await.unwrap();
    let (_shell, _controller) = session.request_shell_extended().await.unwrap();
    let FakeAgentServer {
        received_rx: fake_agent_received_rx,
        task: fake_agent_task,
        ..
    } = fake_agent;

    let server_received =
        tokio::time::timeout(Duration::from_secs(TEST_TIMEOUT_SECS), server_result_rx)
            .await
            .expect("server agent exchange timed out")
            .expect("server agent exchange channel dropped")
            .expect("server agent exchange failed");
    let fake_agent_received = tokio::time::timeout(
        Duration::from_secs(TEST_TIMEOUT_SECS),
        fake_agent_received_rx,
    )
    .await
    .expect("fake agent did not receive request in time")
    .expect("fake agent receive channel dropped");
    let _ = fake_agent_task.await;

    assert_eq!(fake_agent_received, request);
    assert_eq!(server_received, response);
}
