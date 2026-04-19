#![cfg(unix)]

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::Path;
use std::process::{Command, Output};

#[derive(Clone, Debug)]
enum MockBehavior {
    ListActiveConnections,
    ListLocalTerminals,
    SessionInspectSuccess,
    SessionInspectMissing,
    SessionInspectAmbiguous,
    SessionInspectNoHealth,
}

fn base_status() -> Value {
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "pid": 4242,
        "cli_api": { "version": 2, "min_supported": 1 },
        "sessions": 1,
        "connections": { "ssh": 1, "local": 1 }
    })
}

fn session_payload(name: &str) -> Value {
    json!({
        "id": "session-1",
        "connection_id": "conn-1",
        "name": name,
        "host": "example.com",
        "port": 22,
        "username": "deploy",
        "state": "active",
        "uptime_secs": 125,
        "auth_type": "key"
    })
}

fn mock_response(behavior: &MockBehavior, method: &str) -> Result<Value, (i64, String)> {
    match method {
        "status" => Ok(base_status()),
        "list_active_connections" => Ok(json!([
            {
                "id": "conn-1",
                "host": "example.com",
                "port": 22,
                "username": "deploy",
                "state": "active",
                "refCount": 2,
                "keepAlive": true,
                "createdAt": "2026-04-19T11:59:00Z",
                "lastActive": "2026-04-19T12:00:00Z",
                "terminalIds": ["session-1"],
                "sftpSessionId": null,
                "forwardIds": ["fwd-1"],
                "parentConnectionId": null,
                "remoteEnv": null
            }
        ])),
        "list_local_terminals" => Ok(json!([
            {
                "id": "local-1",
                "shell_name": "zsh",
                "shell_id": "shell-zsh",
                "running": true,
                "detached": false
            }
        ])),
        "list_sessions" => match behavior {
            MockBehavior::SessionInspectSuccess | MockBehavior::SessionInspectNoHealth => {
                Ok(json!([session_payload("prod")]))
            }
            MockBehavior::SessionInspectMissing => Ok(json!([])),
            MockBehavior::SessionInspectAmbiguous => Ok(json!([
                session_payload("prod"),
                json!({
                    "id": "session-2",
                    "connection_id": "conn-2",
                    "name": "prod",
                    "host": "example-2.com",
                    "port": 22,
                    "username": "deploy",
                    "state": "active",
                    "uptime_secs": 42,
                    "auth_type": "key"
                })
            ])),
            MockBehavior::ListActiveConnections | MockBehavior::ListLocalTerminals => Ok(json!([])),
        },
        "list_forwards" => Ok(json!([
            {
                "session_id": "session-1",
                "id": "fwd-1",
                "forward_type": "local",
                "bind_address": "127.0.0.1",
                "bind_port": 8080,
                "target_host": "localhost",
                "target_port": 80,
                "status": "active",
                "description": "Web"
            }
        ])),
        "health" => match behavior {
            MockBehavior::SessionInspectNoHealth => {
                Err((-32602, "No health tracker for session: session-1".into()))
            }
            MockBehavior::SessionInspectSuccess => Ok(json!({
                "session_id": "session-1",
                "status": "healthy",
                "latency_ms": 42,
                "message": "Connected • 42ms"
            })),
            _ => Err((-32601, format!("Method not found: {method}"))),
        },
        _ => Err((-32601, format!("Method not found: {method}"))),
    }
}

fn spawn_mock_server(socket_path: &Path, behavior: MockBehavior) -> std::thread::JoinHandle<()> {
    let listener = UnixListener::bind(socket_path).unwrap();

    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let reader_stream = stream.try_clone().unwrap();
        let mut reader = BufReader::new(reader_stream);
        let mut line = String::new();

        loop {
            line.clear();
            if reader.read_line(&mut line).unwrap() == 0 {
                break;
            }

            let request: Value = serde_json::from_str(line.trim()).unwrap();
            let id = request.get("id").and_then(Value::as_u64).unwrap();
            let method = request.get("method").and_then(Value::as_str).unwrap();
            let response = match mock_response(&behavior, method) {
                Ok(result) => json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": result,
                }),
                Err((code, message)) => json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": {
                        "code": code,
                        "message": message,
                    }
                }),
            };

            if stream
                .write_all(serde_json::to_string(&response).unwrap().as_bytes())
                .is_err()
            {
                break;
            }
            if stream.write_all(b"\n").is_err() {
                break;
            }
            if stream.flush().is_err() {
                break;
            }
        }
    })
}

fn run_command(socket_path: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_oxt"))
        .env_remove("OXIDETERM_SOCK")
        .env_remove("OXIDETERM_PIPE")
        .arg("--socket")
        .arg(socket_path)
        .arg("--json")
        .args(args)
        .output()
        .unwrap()
}

#[test]
fn list_active_connections_returns_connection_pool_payload() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let socket_path = temp_dir.path().join("list-active-connections.sock");
    let server = spawn_mock_server(&socket_path, MockBehavior::ListActiveConnections);

    let output = run_command(&socket_path, &["list", "active-connections"]);
    server.join().unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let payload: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(payload[0]["id"], "conn-1");
    assert_eq!(payload[0]["refCount"], 2);
    assert_eq!(payload[0]["keepAlive"], true);
}

#[test]
fn list_local_terminals_returns_terminal_payload() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let socket_path = temp_dir.path().join("list-local-terminals.sock");
    let server = spawn_mock_server(&socket_path, MockBehavior::ListLocalTerminals);

    let output = run_command(&socket_path, &["list", "local-terminals"]);
    server.join().unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let payload: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(payload[0]["id"], "local-1");
    assert_eq!(payload[0]["shell_name"], "zsh");
    assert_eq!(payload[0]["running"], true);
}

#[test]
fn session_inspect_aggregates_session_connection_health_and_forwards() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let socket_path = temp_dir.path().join("session-inspect.sock");
    let server = spawn_mock_server(&socket_path, MockBehavior::SessionInspectSuccess);

    let output = run_command(&socket_path, &["session", "inspect", "prod"]);
    server.join().unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let payload: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(payload["session"]["id"], "session-1");
    assert_eq!(payload["connection"]["id"], "conn-1");
    assert_eq!(payload["health"]["status"], "healthy");
    assert_eq!(payload["forwards"][0]["id"], "fwd-1");
}

#[test]
fn session_inspect_returns_not_found_for_missing_target() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let socket_path = temp_dir.path().join("session-inspect-missing.sock");
    let server = spawn_mock_server(&socket_path, MockBehavior::SessionInspectMissing);

    let output = run_command(&socket_path, &["session", "inspect", "prod"]);
    server.join().unwrap();

    assert_eq!(output.status.code(), Some(4));

    let payload: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(payload["error"]["code"], "not_found");
    assert_eq!(payload["error"]["exit_code"], 4);
}

#[test]
fn session_inspect_returns_usage_for_ambiguous_target() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let socket_path = temp_dir.path().join("session-inspect-ambiguous.sock");
    let server = spawn_mock_server(&socket_path, MockBehavior::SessionInspectAmbiguous);

    let output = run_command(&socket_path, &["session", "inspect", "prod"]);
    server.join().unwrap();

    assert_eq!(output.status.code(), Some(2));

    let payload: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(payload["error"]["code"], "usage_error");
    assert_eq!(payload["error"]["exit_code"], 2);
}

#[test]
fn session_inspect_survives_missing_health_tracker() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let socket_path = temp_dir.path().join("session-inspect-no-health.sock");
    let server = spawn_mock_server(&socket_path, MockBehavior::SessionInspectNoHealth);

    let output = run_command(&socket_path, &["session", "inspect", "prod"]);
    server.join().unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let payload: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(payload["session"]["id"], "session-1");
    assert_eq!(payload["health"], Value::Null);
    assert!(payload["health_error"]
        .as_str()
        .unwrap()
        .contains("No health tracker"));
}
