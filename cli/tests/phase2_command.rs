#![cfg(unix)]

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::Path;
use std::process::{Child, Command, Output, Stdio};

#[derive(Clone, Debug)]
enum MockBehavior {
    StatusWatch,
    HealthWatch,
    ConnectWaitSuccess { appear_after: usize },
    ConnectWaitTimeout,
    ConnectNotFound,
}

#[derive(Default)]
struct MockState {
    status_calls: usize,
    health_calls: usize,
    list_sessions_calls: usize,
}

fn base_status() -> Value {
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "pid": 4242,
        "cli_api": { "version": 1, "min_supported": 1 },
        "sessions": 0,
        "connections": { "ssh": 0, "local": 0 }
    })
}

fn mock_response(
    behavior: &MockBehavior,
    state: &mut MockState,
    method: &str,
    params: Option<&Value>,
) -> Result<Value, (i64, String)> {
    match method {
        "status" => {
            state.status_calls += 1;
            let mut status = base_status();
            if matches!(behavior, MockBehavior::StatusWatch) {
                status["sessions"] = json!(state.status_calls as u64);
                status["connections"]["ssh"] = json!(state.status_calls as u64);
            }
            Ok(status)
        }
        "health" => {
            state.health_calls += 1;
            let session_id = params
                .and_then(|value| value.get("session_id"))
                .and_then(Value::as_str)
                .unwrap_or("session-1");
            Ok(json!({
                "session_id": session_id,
                "status": "healthy",
                "latency_ms": (state.health_calls as u64) * 10,
                "message": "ok"
            }))
        }
        "connect" => match behavior {
            MockBehavior::ConnectNotFound => Err((-32602, "Connection not found: prod".into())),
            MockBehavior::ConnectWaitSuccess { .. } | MockBehavior::ConnectWaitTimeout => {
                Ok(json!({
                    "success": true,
                    "connection_id": "conn-1",
                    "name": "prod"
                }))
            }
            _ => Err((-32601, format!("Method not found: {method}"))),
        },
        "list_sessions" => {
            state.list_sessions_calls += 1;
            match behavior {
                MockBehavior::ConnectWaitSuccess { appear_after } => {
                    if state.list_sessions_calls >= *appear_after {
                        Ok(json!([
                            {
                                "id": "session-1",
                                "connection_id": "conn-1",
                                "name": "prod",
                                "host": "example.com",
                                "state": "active",
                                "uptime_secs": 1
                            }
                        ]))
                    } else {
                        Ok(json!([]))
                    }
                }
                MockBehavior::ConnectWaitTimeout => Ok(json!([])),
                _ => Err((-32601, format!("Method not found: {method}"))),
            }
        }
        _ => Err((-32601, format!("Method not found: {method}"))),
    }
}

fn spawn_mock_server(socket_path: &Path, behavior: MockBehavior) -> std::thread::JoinHandle<()> {
    let listener = UnixListener::bind(socket_path).unwrap();

    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let reader_stream = stream.try_clone().unwrap();
        let mut reader = BufReader::new(reader_stream);
        let mut state = MockState::default();
        let mut line = String::new();

        loop {
            line.clear();
            if reader.read_line(&mut line).unwrap() == 0 {
                break;
            }

            let request: Value = serde_json::from_str(line.trim()).unwrap();
            let id = request.get("id").and_then(Value::as_u64).unwrap();
            let method = request.get("method").and_then(Value::as_str).unwrap();
            let response = match mock_response(&behavior, &mut state, method, request.get("params"))
            {
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

fn base_command(socket_path: &Path, json_output: bool) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_oxt"));
    command
        .env_remove("OXIDETERM_SOCK")
        .env_remove("OXIDETERM_PIPE")
        .arg("--socket")
        .arg(socket_path);
    if json_output {
        command.arg("--json");
    }
    command
}

fn run_command(socket_path: &Path, args: &[&str]) -> Output {
    base_command(socket_path, true).args(args).output().unwrap()
}

fn spawn_command(socket_path: &Path, args: &[&str]) -> Child {
    base_command(socket_path, true)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap()
}

fn read_json_lines(child: &mut Child, count: usize) -> Vec<Value> {
    let mut lines = Vec::with_capacity(count);
    {
        let stdout = child.stdout.as_mut().unwrap();
        let mut reader = BufReader::new(stdout);
        for _ in 0..count {
            let mut line = String::new();
            let bytes = reader.read_line(&mut line).unwrap();
            assert!(bytes > 0, "process exited before producing enough output");
            lines.push(serde_json::from_str(line.trim()).unwrap());
        }
    }
    lines
}

#[test]
fn status_watch_streams_multiple_json_payloads() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let socket_path = temp_dir.path().join("status-watch.sock");
    let server = spawn_mock_server(&socket_path, MockBehavior::StatusWatch);

    let mut child = spawn_command(&socket_path, &["status", "--watch", "--interval", "10"]);
    let lines = read_json_lines(&mut child, 2);
    let _ = child.kill();
    let _ = child.wait_with_output().unwrap();
    server.join().unwrap();

    assert!(lines[0]["sessions"].as_u64().unwrap() < lines[1]["sessions"].as_u64().unwrap());
    assert!(
        lines[0]["connections"]["ssh"].as_u64().unwrap()
            < lines[1]["connections"]["ssh"].as_u64().unwrap()
    );
}

#[test]
fn health_watch_streams_multiple_json_payloads() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let socket_path = temp_dir.path().join("health-watch.sock");
    let server = spawn_mock_server(&socket_path, MockBehavior::HealthWatch);

    let mut child = spawn_command(
        &socket_path,
        &["health", "session-1", "--watch", "--interval", "10"],
    );
    let lines = read_json_lines(&mut child, 2);
    let _ = child.kill();
    let _ = child.wait_with_output().unwrap();
    server.join().unwrap();

    assert_eq!(lines[0]["session_id"], "session-1");
    assert_eq!(lines[0]["status"], "healthy");
    assert!(lines[0]["latency_ms"].as_u64().unwrap() < lines[1]["latency_ms"].as_u64().unwrap());
}

#[test]
fn connect_wait_returns_session_id_when_session_appears() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let socket_path = temp_dir.path().join("connect-wait-ok.sock");
    let server = spawn_mock_server(
        &socket_path,
        MockBehavior::ConnectWaitSuccess { appear_after: 2 },
    );

    let output = run_command(
        &socket_path,
        &[
            "connect",
            "prod",
            "--wait",
            "--interval",
            "10",
            "--wait-timeout",
            "200",
        ],
    );
    server.join().unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let payload: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(payload["success"], true);
    assert_eq!(payload["connection_id"], "conn-1");
    assert_eq!(payload["session_id"], "session-1");
}

#[test]
fn connect_wait_times_out_with_structured_json_error() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let socket_path = temp_dir.path().join("connect-wait-timeout.sock");
    let server = spawn_mock_server(&socket_path, MockBehavior::ConnectWaitTimeout);

    let output = run_command(
        &socket_path,
        &[
            "connect",
            "prod",
            "--wait",
            "--interval",
            "10",
            "--wait-timeout",
            "50",
        ],
    );
    server.join().unwrap();

    assert_eq!(output.status.code(), Some(3));

    let payload: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(payload["error"]["code"], "timeout");
    assert_eq!(payload["error"]["exit_code"], 3);
    assert!(payload["error"]["message"]
        .as_str()
        .unwrap()
        .contains("Timed out waiting for connection"));
}

#[test]
fn connect_not_found_maps_to_not_found_exit_code() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let socket_path = temp_dir.path().join("connect-not-found.sock");
    let server = spawn_mock_server(&socket_path, MockBehavior::ConnectNotFound);

    let output = run_command(&socket_path, &["connect", "prod"]);
    server.join().unwrap();

    assert_eq!(output.status.code(), Some(4));

    let payload: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(payload["error"]["code"], "not_found");
    assert_eq!(payload["error"]["exit_code"], 4);
    assert!(payload["error"]["message"]
        .as_str()
        .unwrap()
        .contains("Connection not found"));
}
