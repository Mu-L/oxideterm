#![cfg(unix)]

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::Path;
use std::process::{Command, Output};
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug)]
enum MockBehavior {
    AskStreamingJson,
    AskStreamingPlainText,
    ExecStreamingJson,
    ExecNonStreamingJson,
    LegacyCliApiV1,
}

#[derive(Clone, Debug, Default)]
struct RequestState {
    ask_requests: Vec<Value>,
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

fn send_json_line(stream: &mut std::os::unix::net::UnixStream, value: &Value) -> bool {
    if stream
        .write_all(serde_json::to_string(value).unwrap().as_bytes())
        .is_err()
    {
        return false;
    }
    if stream.write_all(b"\n").is_err() {
        return false;
    }
    stream.flush().is_ok()
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

            match method {
                "status" => {
                    let status = match behavior {
                        MockBehavior::LegacyCliApiV1 => json!({
                            "version": env!("CARGO_PKG_VERSION"),
                            "pid": 4242,
                            "cli_api": { "version": 1, "min_supported": 1 },
                            "sessions": 1,
                            "connections": { "ssh": 1, "local": 1 }
                        }),
                        _ => base_status(),
                    };
                    let response = json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": status,
                    });
                    if !send_json_line(&mut stream, &response) {
                        break;
                    }
                }
                "ask" => {
                    state.lock().unwrap().ask_requests.push(params.clone());

                    match behavior {
                        MockBehavior::AskStreamingJson => {
                            if params.get("stream").and_then(Value::as_bool) == Some(true) {
                                let notification = json!({
                                    "jsonrpc": "2.0",
                                    "method": "stream_chunk",
                                    "params": { "text": "partial token" },
                                });
                                if !send_json_line(&mut stream, &notification) {
                                    break;
                                }
                            }

                            let response = json!({
                                "jsonrpc": "2.0",
                                "id": id,
                                "result": {
                                    "schema_version": 1,
                                    "content_type": "assistant_text",
                                    "provider": "openai",
                                    "text": "final answer",
                                    "model": "gpt-4o-mini",
                                    "streamed": true,
                                    "conversation_id": "conv-1"
                                }
                            });
                            if !send_json_line(&mut stream, &response) {
                                break;
                            }
                        }
                        MockBehavior::AskStreamingPlainText => {
                            let notification = json!({
                                "jsonrpc": "2.0",
                                "method": "stream_chunk",
                                "params": { "text": "plain text answer" },
                            });
                            if !send_json_line(&mut stream, &notification) {
                                break;
                            }

                            let response = json!({
                                "jsonrpc": "2.0",
                                "id": id,
                                "result": {
                                    "schema_version": 1,
                                    "content_type": "assistant_text",
                                    "provider": "openai",
                                    "text": "plain text answer",
                                    "model": "gpt-4o-mini",
                                    "streamed": true,
                                    "conversation_id": "conv-plain"
                                }
                            });
                            if !send_json_line(&mut stream, &response) {
                                break;
                            }
                        }
                        MockBehavior::ExecStreamingJson => {
                            let notification = json!({
                                "jsonrpc": "2.0",
                                "method": "stream_chunk",
                                "params": { "text": "{\"summary\":\"List files\"}" },
                            });
                            if !send_json_line(&mut stream, &notification) {
                                break;
                            }

                            let response = json!({
                                "jsonrpc": "2.0",
                                "id": id,
                                "result": {
                                    "schema_version": 1,
                                    "content_type": "exec_plan",
                                    "provider": "openai",
                                    "text": "{\"summary\":\"List files\",\"commands\":[{\"command\":\"ls -la\",\"description\":\"List directory contents\"}]}",
                                    "model": "gpt-4o-mini",
                                    "streamed": true,
                                    "shell_target": params.get("shell_target").cloned().unwrap_or(json!(null)),
                                    "plan": {
                                        "shell": params.get("shell_target").cloned().unwrap_or(json!(null)),
                                        "summary": "List files",
                                        "commands": [
                                            {
                                                "command": "ls -la",
                                                "description": "List directory contents"
                                            }
                                        ],
                                        "prerequisites": [],
                                        "risks": [],
                                        "notes": []
                                    },
                                    "conversation_id": "conv-exec"
                                }
                            });
                            if !send_json_line(&mut stream, &response) {
                                break;
                            }
                        }
                        MockBehavior::ExecNonStreamingJson => {
                            let response = json!({
                                "jsonrpc": "2.0",
                                "id": id,
                                "result": {
                                    "schema_version": 1,
                                    "content_type": "exec_plan",
                                    "provider": "openai",
                                    "text": "{\"summary\":\"List files\",\"commands\":[{\"command\":\"ls\",\"description\":\"List current directory\"}]}",
                                    "model": "gpt-4o-mini",
                                    "streamed": false,
                                    "shell_target": params.get("shell_target").cloned().unwrap_or(json!(null)),
                                    "plan": {
                                        "shell": params.get("shell_target").cloned().unwrap_or(json!(null)),
                                        "summary": "List files",
                                        "commands": [
                                            {
                                                "command": "ls",
                                                "description": "List current directory"
                                            }
                                        ],
                                        "prerequisites": [],
                                        "risks": [],
                                        "notes": []
                                    },
                                    "conversation_id": "conv-exec"
                                }
                            });
                            if !send_json_line(&mut stream, &response) {
                                break;
                            }
                        }
                        MockBehavior::LegacyCliApiV1 => {
                            let response = json!({
                                "jsonrpc": "2.0",
                                "id": id,
                                "error": {
                                    "code": -32603,
                                    "message": "ask should not be called when CLI API compatibility fails"
                                }
                            });
                            if !send_json_line(&mut stream, &response) {
                                break;
                            }
                        }
                    }
                }
                _ => {
                    let response = json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": {
                            "code": -32601,
                            "message": format!("Method not found: {method}"),
                        }
                    });
                    if !send_json_line(&mut stream, &response) {
                        break;
                    }
                }
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

fn run_command_without_global_json(socket_path: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_oxt"))
        .env_remove("OXIDETERM_SOCK")
        .env_remove("OXIDETERM_PIPE")
        .arg("--socket")
        .arg(socket_path)
        .args(args)
        .output()
        .unwrap()
}

#[test]
fn ask_json_streaming_buffers_and_returns_final_json_object() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let socket_path = temp_dir.path().join("ask-streaming-json.sock");
    let state = Arc::new(Mutex::new(RequestState::default()));
    let server = spawn_mock_server(&socket_path, MockBehavior::AskStreamingJson, state.clone());

    let output = run_command(&socket_path, &["ask", "summarize this"]);
    server.join().unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let payload: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(payload["schema_version"], 1);
    assert_eq!(payload["content_type"], "assistant_text");
    assert_eq!(payload["provider"], "openai");
    assert_eq!(payload["streamed"], true);
    assert_eq!(payload["text"], "final answer");
    assert_eq!(payload["conversation_id"], "conv-1");
    assert_eq!(state.lock().unwrap().ask_requests[0]["stream"], true);
}

#[test]
fn ask_keeps_dash_prefixed_prompt_tokens_as_prompt_text() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let socket_path = temp_dir.path().join("ask-dashed-prompt.sock");
    let state = Arc::new(Mutex::new(RequestState::default()));
    let server = spawn_mock_server(&socket_path, MockBehavior::AskStreamingJson, state.clone());

    let output = run_command(&socket_path, &["ask", "explain", "--bar"]);
    server.join().unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let requests = &state.lock().unwrap().ask_requests;
    assert_eq!(requests[0]["prompt"], "explain --bar");
}

#[test]
fn ask_defaults_to_plain_text_when_stdout_is_piped() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let socket_path = temp_dir.path().join("ask-plain-text.sock");
    let state = Arc::new(Mutex::new(RequestState::default()));
    let server = spawn_mock_server(
        &socket_path,
        MockBehavior::AskStreamingPlainText,
        state.clone(),
    );

    let output = run_command_without_global_json(&socket_path, &["ask", "summarize this"]);
    server.join().unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "plain text answer\n"
    );
}

#[test]
fn exec_json_passes_shell_target_and_returns_structured_plan() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let socket_path = temp_dir.path().join("exec-streaming-json.sock");
    let state = Arc::new(Mutex::new(RequestState::default()));
    let server = spawn_mock_server(&socket_path, MockBehavior::ExecStreamingJson, state.clone());

    let output = run_command(
        &socket_path,
        &["exec", "list files", "--shell", "zsh", "--format", "json"],
    );
    server.join().unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let payload: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(payload["schema_version"], 1);
    assert_eq!(payload["content_type"], "exec_plan");
    assert_eq!(payload["provider"], "openai");
    assert_eq!(payload["streamed"], true);
    assert_eq!(payload["shell_target"], "zsh");
    assert_eq!(payload["plan"]["commands"][0]["command"], "ls -la");

    let requests = &state.lock().unwrap().ask_requests;
    assert_eq!(requests[0]["exec_mode"], true);
    assert_eq!(requests[0]["shell_target"], "zsh");
    assert_eq!(requests[0]["stream"], true);
}

#[test]
fn exec_no_stream_disables_streaming_request_flag() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let socket_path = temp_dir.path().join("exec-no-stream-json.sock");
    let state = Arc::new(Mutex::new(RequestState::default()));
    let server = spawn_mock_server(
        &socket_path,
        MockBehavior::ExecNonStreamingJson,
        state.clone(),
    );

    let output = run_command(
        &socket_path,
        &[
            "exec",
            "list files",
            "--shell",
            "bash",
            "--format",
            "json",
            "--no-stream",
        ],
    );
    server.join().unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let payload: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(payload["schema_version"], 1);
    assert_eq!(payload["provider"], "openai");
    assert_eq!(payload["streamed"], false);
    assert_eq!(state.lock().unwrap().ask_requests[0]["stream"], false);
}

#[test]
fn exec_shell_alias_normalizes_to_powershell() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let socket_path = temp_dir.path().join("exec-powershell-alias.sock");
    let state = Arc::new(Mutex::new(RequestState::default()));
    let server = spawn_mock_server(
        &socket_path,
        MockBehavior::ExecNonStreamingJson,
        state.clone(),
    );

    let output = run_command(
        &socket_path,
        &[
            "exec",
            "echo hi",
            "--shell",
            "power-shell",
            "--format",
            "json",
            "--no-stream",
        ],
    );
    server.join().unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let payload: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(payload["shell_target"], "powershell");
    assert_eq!(
        state.lock().unwrap().ask_requests[0]["shell_target"],
        "powershell"
    );
}

#[test]
fn ask_rejects_legacy_gui_before_sending_rpc() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let socket_path = temp_dir.path().join("ask-legacy-gui.sock");
    let state = Arc::new(Mutex::new(RequestState::default()));
    let server = spawn_mock_server(&socket_path, MockBehavior::LegacyCliApiV1, state.clone());

    let output = run_command(&socket_path, &["ask", "summarize this"]);
    server.join().unwrap();

    assert_eq!(output.status.code(), Some(5));

    let payload: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(payload["error"]["code"], "compatibility_error");
    assert_eq!(payload["error"]["exit_code"], 5);
    assert!(payload["error"]["message"]
        .as_str()
        .unwrap_or_default()
        .contains("CLI API mismatch"));
    assert!(state.lock().unwrap().ask_requests.is_empty());
}

#[test]
fn exec_format_text_overrides_auto_json_when_stdout_is_piped() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let socket_path = temp_dir.path().join("exec-text-format.sock");
    let state = Arc::new(Mutex::new(RequestState::default()));
    let server = spawn_mock_server(
        &socket_path,
        MockBehavior::ExecNonStreamingJson,
        state.clone(),
    );

    let output = run_command_without_global_json(
        &socket_path,
        &[
            "exec",
            "list files",
            "--shell",
            "bash",
            "--format",
            "text",
            "--no-stream",
        ],
    );
    server.join().unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("Exec plan (bash)"));
    assert!(stdout.contains("Summary:"));
}

#[test]
fn exec_format_json_emits_envelope_without_global_json_flag() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let socket_path = temp_dir.path().join("exec-format-json.sock");
    let state = Arc::new(Mutex::new(RequestState::default()));
    let server = spawn_mock_server(
        &socket_path,
        MockBehavior::ExecNonStreamingJson,
        state.clone(),
    );

    let output = run_command_without_global_json(
        &socket_path,
        &["exec", "list files", "--format", "json", "--no-stream"],
    );
    server.join().unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let payload: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(payload["content_type"], "exec_plan");
    assert_eq!(payload["provider"], "openai");
    assert_eq!(payload["streamed"], false);
}
