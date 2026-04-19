#![cfg(unix)]

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::Path;
use std::process::{Command, Output};
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug)]
enum MockBehavior {
    ConnectFocus,
    FocusLatest,
    FocusLatestMissing,
    FocusAmbiguous,
}

#[derive(Clone, Debug, Default)]
struct RequestState {
    list_sessions_calls: usize,
    focus_targets: Vec<String>,
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

fn connect_session(created_at: &str) -> Value {
    json!({
        "id": "session-1",
        "connection_id": "conn-1",
        "name": "prod",
        "host": "example.com",
        "port": 22,
        "username": "deploy",
        "state": "active",
        "uptime_secs": 12,
        "created_at": created_at,
        "auth_type": "key"
    })
}

fn mock_response(
    behavior: &MockBehavior,
    state: &Arc<Mutex<RequestState>>,
    method: &str,
    params: &Value,
) -> Result<Value, (i64, String)> {
    match method {
        "status" => Ok(base_status()),
        "connect" => match behavior {
            MockBehavior::ConnectFocus => Ok(json!({
                "session_id": "session-1",
                "connection_id": "conn-1",
                "host": "example.com",
                "port": 22,
                "username": "deploy"
            })),
            _ => Err((-32601, format!("Method not found: {method}"))),
        },
        "list_sessions" => match behavior {
            MockBehavior::ConnectFocus => {
                let mut guard = state.lock().unwrap();
                guard.list_sessions_calls += 1;
                if guard.list_sessions_calls == 1 {
                    Ok(json!([]))
                } else {
                    Ok(json!([connect_session("2026-04-19T12:00:00Z")]))
                }
            }
            MockBehavior::FocusLatest => Ok(json!([
                connect_session("2026-04-19T12:00:00Z"),
                json!({
                    "id": "session-2",
                    "connection_id": "conn-2",
                    "name": "staging",
                    "host": "staging.example.com",
                    "port": 22,
                    "username": "deploy",
                    "state": "active",
                    "uptime_secs": 5,
                    "created_at": "2026-04-19T12:00:02Z",
                    "auth_type": "key"
                })
            ])),
            MockBehavior::FocusLatestMissing => Ok(json!([])),
            MockBehavior::FocusAmbiguous => Ok(json!([
                connect_session("2026-04-19T12:00:00Z"),
                json!({
                    "id": "session-2",
                    "connection_id": "conn-2",
                    "name": "prod",
                    "host": "staging.example.com",
                    "port": 22,
                    "username": "deploy",
                    "state": "active",
                    "uptime_secs": 5,
                    "created_at": "2026-04-19T12:00:02Z",
                    "auth_type": "key"
                })
            ])),
        },
        "list_local_terminals" => match behavior {
            MockBehavior::FocusLatest => Ok(json!([
                {
                    "id": "local-1",
                    "shell_name": "zsh",
                    "shell_id": "shell-zsh",
                    "created_at": "2026-04-19T12:00:03Z",
                    "running": true,
                    "detached": false
                }
            ])),
            MockBehavior::FocusAmbiguous => Ok(json!([
                {
                    "id": "local-1",
                    "shell_name": "prod",
                    "shell_id": "shell-prod",
                    "created_at": "2026-04-19T12:00:03Z",
                    "running": true,
                    "detached": false
                }
            ])),
            _ => Ok(json!([])),
        },
        "focus_tab" => {
            let target = params
                .get("target")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            state.lock().unwrap().focus_targets.push(target.clone());
            Ok(json!({
                "ok": true,
                "matched": if target.starts_with("local-") {
                    "local_terminal"
                } else {
                    "session"
                },
                "target": target
            }))
        }
        _ => Err((-32601, format!("Method not found: {method}"))),
    }
}

fn spawn_mock_server(
    socket_path: &Path,
    behavior: MockBehavior,
    state: Arc<Mutex<RequestState>>,
) -> std::thread::JoinHandle<()> {
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
            let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
            let response = match mock_response(&behavior, &state, method, &params) {
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
fn connect_focus_waits_for_session_and_focuses_resulting_tab() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let socket_path = temp_dir.path().join("connect-focus.sock");
    let state = Arc::new(Mutex::new(RequestState::default()));
    let server = spawn_mock_server(&socket_path, MockBehavior::ConnectFocus, state.clone());

    let output = run_command(
        &socket_path,
        &["connect", "prod", "--focus", "--interval", "1"],
    );
    server.join().unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let payload: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(payload["session_id"], "session-1");
    assert_eq!(payload["focused"], true);
    assert_eq!(payload["focus_result"]["matched"], "session");

    let state = state.lock().unwrap();
    assert!(state.list_sessions_calls >= 2);
    assert_eq!(state.focus_targets, vec!["session-1"]);
}

#[test]
fn focus_latest_prefers_newest_focusable_target() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let socket_path = temp_dir.path().join("focus-latest.sock");
    let state = Arc::new(Mutex::new(RequestState::default()));
    let server = spawn_mock_server(&socket_path, MockBehavior::FocusLatest, state.clone());

    let output = run_command(&socket_path, &["focus", "--latest"]);
    server.join().unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let payload: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(payload["target"], "local-1");
    assert_eq!(payload["matched"], "local_terminal");
    assert_eq!(state.lock().unwrap().focus_targets, vec!["local-1"]);
}

#[test]
fn focus_latest_returns_not_found_when_no_targets_exist() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let socket_path = temp_dir.path().join("focus-latest-missing.sock");
    let state = Arc::new(Mutex::new(RequestState::default()));
    let server = spawn_mock_server(&socket_path, MockBehavior::FocusLatestMissing, state);

    let output = run_command(&socket_path, &["focus", "--latest"]);
    server.join().unwrap();

    assert_eq!(output.status.code(), Some(4));

    let payload: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(payload["error"]["code"], "not_found");
}

#[test]
fn focus_explicit_target_rejects_ambiguous_matches() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let socket_path = temp_dir.path().join("focus-ambiguous.sock");
    let state = Arc::new(Mutex::new(RequestState::default()));
    let server = spawn_mock_server(&socket_path, MockBehavior::FocusAmbiguous, state.clone());

    let output = run_command(&socket_path, &["focus", "prod"]);
    server.join().unwrap();

    assert_eq!(output.status.code(), Some(2));

    let payload: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(payload["error"]["code"], "usage_error");
    assert!(state.lock().unwrap().focus_targets.is_empty());
}
