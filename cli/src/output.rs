// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

//! Output formatting for CLI responses.
//!
//! Automatically detects terminal vs pipe context.
//! - Terminal: human-readable colored tables
//! - Pipe: structured JSON

use crate::DoctorReport;
use std::io::IsTerminal;

use serde_json::Value;

/// Output mode for CLI responses.
pub enum OutputMode {
    Human,
    Json,
}

impl OutputMode {
    /// Detect output mode based on terminal detection and flags.
    pub fn detect(force_json: bool) -> Self {
        if force_json || !is_terminal_stdout() {
            Self::Json
        } else {
            Self::Human
        }
    }

    pub fn is_json(&self) -> bool {
        matches!(self, Self::Json)
    }

    /// Print raw JSON value (pretty for human, compact for pipe).
    pub fn print_json(&self, value: &Value) {
        match self {
            Self::Human => {
                println!(
                    "{}",
                    serde_json::to_string_pretty(value).unwrap_or_default()
                );
            }
            Self::Json => {
                println!("{}", serde_json::to_string(value).unwrap_or_default());
            }
        }
    }

    /// Print doctor diagnostics.
    pub fn print_doctor(&self, report: &DoctorReport) {
        match self {
            Self::Json => {
                println!("{}", serde_json::to_string(report).unwrap_or_default());
            }
            Self::Human => {
                print!("{}", render_doctor_human(report));
            }
        }
    }

    /// Print status response.
    pub fn print_status(&self, value: &Value) {
        match self {
            Self::Json => {
                println!("{}", serde_json::to_string(value).unwrap_or_default());
            }
            Self::Human => {
                let version = value
                    .get("version")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");
                let cli_api_version = value.pointer("/cli_api/version").and_then(|v| v.as_u64());
                let cli_api_min_supported = value
                    .pointer("/cli_api/min_supported")
                    .and_then(|v| v.as_u64());
                let sessions = value.get("sessions").and_then(|v| v.as_u64()).unwrap_or(0);
                let ssh = value
                    .pointer("/connections/ssh")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let local = value
                    .pointer("/connections/local")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);

                println!("OxideTerm v{version}");
                if let Some(api_version) = cli_api_version {
                    let api_min = cli_api_min_supported.unwrap_or(api_version);
                    if api_min == api_version {
                        println!("  CLI API:       v{api_version}");
                    } else {
                        println!("  CLI API:       {api_min}-{api_version}");
                    }
                }
                println!("  Sessions:      {sessions} active");
                println!("  Connections:   {ssh} SSH, {local} local");
            }
        }
    }

    /// Print saved connections list.
    pub fn print_connections(&self, value: &Value) {
        match self {
            Self::Json => {
                println!("{}", serde_json::to_string(value).unwrap_or_default());
            }
            Self::Human => {
                let items = value.as_array().map(|a| a.as_slice()).unwrap_or(&[]);
                if items.is_empty() {
                    println!("No saved connections");
                    return;
                }

                println!(
                    "  {:<16} {:<24} {:<6} {:<10} {}",
                    "NAME", "HOST", "PORT", "USER", "TYPE"
                );
                for item in items {
                    let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("-");
                    let host = item.get("host").and_then(|v| v.as_str()).unwrap_or("-");
                    let port = item.get("port").and_then(|v| v.as_u64()).unwrap_or(22);
                    let user = item.get("username").and_then(|v| v.as_str()).unwrap_or("-");
                    let auth = item
                        .get("auth_type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("-");
                    println!(
                        "  {:<16} {:<24} {:<6} {:<10} {}",
                        sanitize_display(name),
                        sanitize_display(host),
                        port,
                        sanitize_display(user),
                        auth
                    );
                }
            }
        }
    }

    /// Print active sessions list.
    pub fn print_sessions(&self, value: &Value) {
        match self {
            Self::Json => {
                println!("{}", serde_json::to_string(value).unwrap_or_default());
            }
            Self::Human => {
                let items = value.as_array().map(|a| a.as_slice()).unwrap_or(&[]);
                if items.is_empty() {
                    println!("No active sessions");
                    return;
                }

                println!(
                    "  {:<14} {:<16} {:<24} {:<10} {}",
                    "ID", "NAME", "HOST", "STATE", "UPTIME"
                );
                for item in items {
                    let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("-");
                    let short_id = if id.len() > 12 { &id[..12] } else { id };
                    let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("-");
                    let host = item.get("host").and_then(|v| v.as_str()).unwrap_or("-");
                    let state = item.get("state").and_then(|v| v.as_str()).unwrap_or("-");
                    let uptime = item
                        .get("uptime_secs")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    let uptime_str = format_duration(uptime);
                    println!(
                        "  {:<14} {:<16} {:<24} {:<10} {}",
                        short_id,
                        sanitize_display(name),
                        sanitize_display(host),
                        state,
                        uptime_str
                    );
                }
            }
        }
    }

    /// Print active SSH connections in the pool.
    pub fn print_active_connections(&self, value: &Value) {
        match self {
            Self::Json => {
                println!("{}", serde_json::to_string(value).unwrap_or_default());
            }
            Self::Human => {
                print!("{}", render_active_connections_human(value));
            }
        }
    }

    /// Print local terminals list.
    pub fn print_local_terminals(&self, value: &Value) {
        match self {
            Self::Json => {
                println!("{}", serde_json::to_string(value).unwrap_or_default());
            }
            Self::Human => {
                let items = value.as_array().map(|a| a.as_slice()).unwrap_or(&[]);
                if items.is_empty() {
                    println!("  No local terminals");
                    return;
                }

                println!(
                    "  {:<14} {:<16} {:<10} {}",
                    "ID", "SHELL", "RUNNING", "DETACHED"
                );
                for item in items {
                    let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("-");
                    let short_id = if id.len() > 12 { &id[..12] } else { id };
                    let shell = item
                        .get("shell_name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("-");
                    let running = item
                        .get("running")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let detached = item
                        .get("detached")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    println!(
                        "  {:<14} {:<16} {:<10} {}",
                        short_id,
                        sanitize_display(shell),
                        if running { "yes" } else { "no" },
                        if detached { "yes" } else { "no" },
                    );
                }
            }
        }
    }

    /// Print port forwards list.
    pub fn print_forwards(&self, value: &Value) {
        match self {
            Self::Json => {
                println!("{}", serde_json::to_string(value).unwrap_or_default());
            }
            Self::Human => {
                let items = value.as_array().map(|a| a.as_slice()).unwrap_or(&[]);
                if items.is_empty() {
                    println!("No active port forwards");
                    return;
                }

                println!(
                    "  {:<10} {:<8} {:<24} {:<24} {:<10} {}",
                    "SESSION", "TYPE", "BIND", "TARGET", "STATUS", "DESC"
                );
                for item in items {
                    let session = item
                        .get("session_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("-");
                    let short_session = if session.len() > 8 {
                        &session[..8]
                    } else {
                        session
                    };
                    let fwd_type = item
                        .get("forward_type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("-");
                    let bind_addr = item
                        .get("bind_address")
                        .and_then(|v| v.as_str())
                        .unwrap_or("0.0.0.0");
                    let bind_port = item.get("bind_port").and_then(|v| v.as_u64()).unwrap_or(0);
                    let target_host = item
                        .get("target_host")
                        .and_then(|v| v.as_str())
                        .unwrap_or("-");
                    let target_port = item
                        .get("target_port")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    let status = item.get("status").and_then(|v| v.as_str()).unwrap_or("-");
                    let desc = item
                        .get("description")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");

                    let bind_str = format!("{bind_addr}:{bind_port}");
                    let target_str = if fwd_type == "dynamic" {
                        "SOCKS5".to_string()
                    } else {
                        format!("{target_host}:{target_port}")
                    };

                    println!(
                        "  {:<10} {:<8} {:<24} {:<24} {:<10} {}",
                        short_session,
                        fwd_type,
                        bind_str,
                        target_str,
                        status,
                        sanitize_display(desc)
                    );
                }
            }
        }
    }

    /// Print health status.
    pub fn print_health(&self, value: &Value, single: bool) {
        match self {
            Self::Json => {
                println!("{}", serde_json::to_string(value).unwrap_or_default());
            }
            Self::Human => {
                if single {
                    // Single session health (QuickHealthCheck)
                    let status = value
                        .get("status")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown");
                    let latency = value.get("latency_ms").and_then(|v| v.as_u64());
                    let message = value.get("message").and_then(|v| v.as_str()).unwrap_or("");
                    let session_id = value
                        .get("session_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("-");

                    let status_icon = match status {
                        "healthy" => "●",
                        "degraded" => "◐",
                        "unresponsive" => "○",
                        "disconnected" => "✕",
                        _ => "?",
                    };

                    let latency_str = latency
                        .map(|l| format!("{l}ms"))
                        .unwrap_or_else(|| "-".to_string());

                    println!("{status_icon} {session_id}");
                    println!("  Status:    {status}");
                    println!("  Latency:   {latency_str}");
                    println!("  Message:   {message}");
                } else {
                    // All sessions health (HashMap<String, QuickHealthCheck>)
                    let obj = value.as_object();
                    if obj.map(|o| o.is_empty()).unwrap_or(true) {
                        println!("No active sessions with health data");
                        return;
                    }

                    println!(
                        "  {:<14} {:<14} {:<10} {}",
                        "SESSION", "STATUS", "LATENCY", "MESSAGE"
                    );
                    if let Some(map) = obj {
                        for (session_id, check) in map {
                            let short_id = if session_id.len() > 12 {
                                &session_id[..12]
                            } else {
                                session_id
                            };
                            let status = check
                                .get("status")
                                .and_then(|v| v.as_str())
                                .unwrap_or("unknown");
                            let latency = check
                                .get("latency_ms")
                                .and_then(|v| v.as_u64())
                                .map(|l| format!("{l}ms"))
                                .unwrap_or_else(|| "-".to_string());
                            let message =
                                check.get("message").and_then(|v| v.as_str()).unwrap_or("");
                            println!(
                                "  {:<14} {:<14} {:<10} {}",
                                short_id, status, latency, message
                            );
                        }
                    }
                }
            }
        }
    }

    /// Print aggregated session inspection details.
    pub fn print_session_inspect(&self, value: &Value) {
        match self {
            Self::Json => {
                println!("{}", serde_json::to_string(value).unwrap_or_default());
            }
            Self::Human => {
                print!("{}", render_session_inspect_human(value));
            }
        }
    }

    /// Print disconnect result.
    pub fn print_disconnect(&self, value: &Value) {
        match self {
            Self::Json => {
                println!("{}", serde_json::to_string(value).unwrap_or_default());
            }
            Self::Human => {
                let success = value
                    .get("success")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let session_id = value
                    .get("session_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");
                if success {
                    println!("Disconnected session: {session_id}");
                } else {
                    let error = value
                        .get("error")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Unknown error");
                    println!("Failed to disconnect: {error}");
                }
            }
        }
    }

    /// Print version information.
    pub fn print_version(&self) {
        let version = env!("CARGO_PKG_VERSION");
        match self {
            Self::Json => {
                println!(
                    "{}",
                    serde_json::to_string(&serde_json::json!({
                        "cli_version": version
                    }))
                    .unwrap_or_default()
                );
            }
            Self::Human => {
                println!("oxt {version}");
            }
        }
    }

    /// Print config list (groups with connection counts).
    pub fn print_config_list(&self, value: &Value) {
        match self {
            Self::Json => {
                println!("{}", serde_json::to_string(value).unwrap_or_default());
            }
            Self::Human => {
                let total = value
                    .get("total_connections")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let groups = value
                    .get("groups")
                    .and_then(|v| v.as_array())
                    .map(|a| a.as_slice())
                    .unwrap_or(&[]);

                println!("Saved connections: {total}");
                if groups.is_empty() {
                    return;
                }
                println!();
                println!("  {:<24} {}", "GROUP", "COUNT");
                for group in groups {
                    let name = group.get("name").and_then(|v| v.as_str()).unwrap_or("-");
                    let count = group.get("count").and_then(|v| v.as_u64()).unwrap_or(0);
                    println!("  {:<24} {}", sanitize_display(name), count);
                }
            }
        }
    }

    /// Print config get (connection details).
    pub fn print_config_get(&self, value: &Value) {
        match self {
            Self::Json => {
                println!("{}", serde_json::to_string(value).unwrap_or_default());
            }
            Self::Human => {
                let name = value.get("name").and_then(|v| v.as_str()).unwrap_or("-");
                let host = value.get("host").and_then(|v| v.as_str()).unwrap_or("-");
                let port = value.get("port").and_then(|v| v.as_u64()).unwrap_or(22);
                let user = value
                    .get("username")
                    .and_then(|v| v.as_str())
                    .unwrap_or("-");
                let auth = value
                    .get("auth_type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("-");
                let group = value
                    .get("group")
                    .and_then(|v| v.as_str())
                    .unwrap_or("(none)");
                let key_path = value.get("key_path").and_then(|v| v.as_str());

                println!("{}", sanitize_display(name));
                println!("  Host:       {}:{port}", sanitize_display(host));
                println!("  User:       {}", sanitize_display(user));
                println!("  Auth:       {auth}");
                if let Some(kp) = key_path {
                    println!("  Key:        {kp}");
                }
                println!("  Group:      {group}");

                // Proxy chain
                if let Some(chain) = value.get("proxy_chain").and_then(|v| v.as_array()) {
                    if !chain.is_empty() {
                        println!("  Proxy hops:");
                        for hop in chain {
                            let h = hop.get("host").and_then(|v| v.as_str()).unwrap_or("-");
                            let p = hop.get("port").and_then(|v| v.as_u64()).unwrap_or(22);
                            let u = hop.get("username").and_then(|v| v.as_str()).unwrap_or("-");
                            println!("    → {u}@{h}:{p}");
                        }
                    }
                }

                // Options
                if let Some(opts) = value.get("options") {
                    let ka = opts
                        .get("keep_alive_interval")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    let comp = opts
                        .get("compression")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    if ka > 0 || comp {
                        println!("  Options:");
                        if ka > 0 {
                            println!("    Keep-alive:   {ka}s");
                        }
                        if comp {
                            println!("    Compression:  on");
                        }
                    }
                }
            }
        }
    }

    /// Print forward create/delete result.
    pub fn print_forward_result(&self, value: &Value) {
        match self {
            Self::Json => {
                println!("{}", serde_json::to_string(value).unwrap_or_default());
            }
            Self::Human => {
                let success = value
                    .get("success")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                if success {
                    if let Some(fwd) = value.get("forward") {
                        let ftype = fwd
                            .get("forward_type")
                            .and_then(|v| v.as_str())
                            .unwrap_or("-");
                        let bind = format!(
                            "{}:{}",
                            fwd.get("bind_address")
                                .and_then(|v| v.as_str())
                                .unwrap_or("127.0.0.1"),
                            fwd.get("bind_port").and_then(|v| v.as_u64()).unwrap_or(0)
                        );
                        let target = if ftype == "dynamic" {
                            "SOCKS5".to_string()
                        } else {
                            format!(
                                "{}:{}",
                                fwd.get("target_host")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("-"),
                                fwd.get("target_port").and_then(|v| v.as_u64()).unwrap_or(0)
                            )
                        };
                        let id = fwd.get("id").and_then(|v| v.as_str()).unwrap_or("-");
                        println!("Forward created: {ftype} {bind} → {target}");
                        println!("  ID: {id}");
                    } else if let Some(fwd_id) = value.get("forward_id").and_then(|v| v.as_str()) {
                        println!("Forward removed: {fwd_id}");
                    } else {
                        println!("Success");
                    }
                } else {
                    let error = value
                        .get("error")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Unknown error");
                    eprintln!("Failed: {error}");
                }
            }
        }
    }

    /// Print AI response (non-streaming).
    pub fn print_ai_response(&self, value: &Value) {
        match self {
            Self::Json => {
                println!("{}", serde_json::to_string(value).unwrap_or_default());
            }
            Self::Human => {
                if let Some(text) = value.get("text").and_then(|v| v.as_str()) {
                    println!("{text}");
                } else if let Some(err) = value.get("error").and_then(|v| v.as_str()) {
                    eprintln!("AI error: {err}");
                }
            }
        }
    }

    /// Print structured exec response.
    pub fn print_exec_result(&self, value: &Value) {
        match self {
            Self::Json => {
                println!("{}", serde_json::to_string(value).unwrap_or_default());
            }
            Self::Human => {
                print!("{}", render_exec_result_human(value));
            }
        }
    }

    /// Print connect result.
    pub fn print_connect_result(&self, value: &Value) {
        match self {
            Self::Json => {
                println!("{}", serde_json::to_string(value).unwrap_or_default());
            }
            Self::Human => {
                let success = value
                    .get("success")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                if success {
                    let name = value.get("name").and_then(|v| v.as_str()).unwrap_or("-");
                    if let Some(session_id) = value.get("session_id").and_then(|v| v.as_str()) {
                        println!(
                            "Connected to {} (session {})",
                            sanitize_display(name),
                            session_id
                        );
                    } else {
                        println!("Connecting to {}...", sanitize_display(name));
                    }
                    if value
                        .get("focused")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false)
                    {
                        println!("  Focused:    yes");
                    }
                } else {
                    let error = value
                        .get("error")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Unknown error");
                    eprintln!("Failed: {error}");
                }
            }
        }
    }

    /// Print SFTP directory listing.
    pub fn print_sftp_ls(&self, value: &Value) {
        match self {
            Self::Json => {
                println!("{}", serde_json::to_string(value).unwrap_or_default());
            }
            Self::Human => {
                let path = value.get("path").and_then(|v| v.as_str()).unwrap_or(".");
                let entries = value
                    .get("entries")
                    .and_then(|v| v.as_array())
                    .map(|a| a.as_slice())
                    .unwrap_or(&[]);

                println!("{path}  ({} entries)", entries.len());
                if entries.is_empty() {
                    return;
                }

                println!("  {:<10} {:<10} {:<8} {}", "PERMS", "SIZE", "TYPE", "NAME");
                for entry in entries {
                    let name = entry.get("name").and_then(|v| v.as_str()).unwrap_or("-");
                    let file_type = entry.get("type").and_then(|v| v.as_str()).unwrap_or("-");
                    let size = entry.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
                    let permissions = entry
                        .get("permissions")
                        .and_then(|v| v.as_str())
                        .unwrap_or("---");
                    let is_symlink = entry
                        .get("is_symlink")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);

                    let type_char = match file_type {
                        "Directory" => "d",
                        "Symlink" => "l",
                        "File" => "-",
                        _ => "?",
                    };
                    let size_str = format_file_size(size);
                    let display_name = if is_symlink {
                        format!("{} →", sanitize_display(name))
                    } else {
                        sanitize_display(name)
                    };

                    println!(
                        "  {}{:<9} {:<10} {:<8} {}",
                        type_char, permissions, size_str, file_type, display_name
                    );
                }
            }
        }
    }

    /// Print SFTP transfer result (download or upload).
    pub fn print_sftp_transfer(&self, value: &Value, verb: &str) {
        match self {
            Self::Json => {
                println!("{}", serde_json::to_string(value).unwrap_or_default());
            }
            Self::Human => {
                let remote = value
                    .get("remote_path")
                    .and_then(|v| v.as_str())
                    .unwrap_or("?");
                let local = value
                    .get("local_path")
                    .and_then(|v| v.as_str())
                    .unwrap_or("?");
                let bytes = value.get("bytes").and_then(|v| v.as_u64()).unwrap_or(0);
                let size_str = format_file_size(bytes);
                println!("{verb}: {remote} ↔ {local} ({size_str})");
            }
        }
    }

    /// Print importable SSH config hosts.
    pub fn print_import_list(&self, value: &Value) {
        match self {
            Self::Json => {
                println!("{}", serde_json::to_string(value).unwrap_or_default());
            }
            Self::Human => {
                let items = value.as_array().map(|a| a.as_slice()).unwrap_or(&[]);
                if items.is_empty() {
                    println!("No hosts found in ~/.ssh/config");
                    return;
                }

                println!(
                    "  {:<20} {:<24} {:<10} {:<6} {}",
                    "ALIAS", "HOSTNAME", "USER", "PORT", "STATUS"
                );
                for item in items {
                    let alias = item.get("alias").and_then(|v| v.as_str()).unwrap_or("-");
                    let hostname = item.get("hostname").and_then(|v| v.as_str()).unwrap_or("-");
                    let user = item.get("user").and_then(|v| v.as_str()).unwrap_or("-");
                    let port = item.get("port").and_then(|v| v.as_u64()).unwrap_or(22);
                    let imported = item
                        .get("already_imported")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let status = if imported { "imported" } else { "available" };

                    println!(
                        "  {:<20} {:<24} {:<10} {:<6} {}",
                        sanitize_display(alias),
                        sanitize_display(hostname),
                        sanitize_display(user),
                        port,
                        status
                    );
                }
            }
        }
    }

    /// Print import result summary.
    pub fn print_import_result(&self, value: &Value) {
        match self {
            Self::Json => {
                println!("{}", serde_json::to_string(value).unwrap_or_default());
            }
            Self::Human => {
                let imported = value.get("imported").and_then(|v| v.as_u64()).unwrap_or(0);
                let skipped = value.get("skipped").and_then(|v| v.as_u64()).unwrap_or(0);
                let errors = value
                    .get("errors")
                    .and_then(|v| v.as_array())
                    .map(|a| a.len())
                    .unwrap_or(0);

                println!("Imported: {imported}, Skipped: {skipped}, Errors: {errors}");

                if let Some(errs) = value.get("errors").and_then(|v| v.as_array()) {
                    for err in errs {
                        if let Some(msg) = err.as_str() {
                            eprintln!("  ✕ {msg}");
                        }
                    }
                }
            }
        }
    }
}

fn format_duration(secs: u64) -> String {
    if secs < 60 {
        format!("{secs}s")
    } else if secs < 3600 {
        format!("{}m {}s", secs / 60, secs % 60)
    } else {
        let h = secs / 3600;
        let m = (secs % 3600) / 60;
        format!("{h}h {m}m")
    }
}

/// Check if stdout is connected to a terminal (not piped).
fn is_terminal_stdout() -> bool {
    std::io::stdout().is_terminal()
}

/// Strip ANSI escape sequences and control characters from a string
/// to prevent terminal injection attacks via crafted connection names.
fn sanitize_display(s: &str) -> String {
    sanitize_filtered_display(s, false)
}

fn sanitize_multiline_display(s: &str) -> String {
    sanitize_filtered_display(s, true)
}

fn sanitize_filtered_display(s: &str, allow_newlines: bool) -> String {
    let mut result = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            // Skip ESC sequence: ESC [ ... final_byte
            if chars.peek() == Some(&'[') {
                chars.next(); // consume '['
                              // Consume until we hit a letter (final byte of CSI sequence)
                for c2 in chars.by_ref() {
                    if c2.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
        } else if c >= ' ' || c == '\t' || (allow_newlines && c == '\n') {
            result.push(c);
        }
        // Drop other control characters
    }
    result
}

/// Format a file size in human-readable form.
fn format_file_size(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = 1024 * KB;
    const GB: u64 = 1024 * MB;

    if bytes >= GB {
        format!("{:.1}G", bytes as f64 / GB as f64)
    } else if bytes >= MB {
        format!("{:.1}M", bytes as f64 / MB as f64)
    } else if bytes >= KB {
        format!("{:.1}K", bytes as f64 / KB as f64)
    } else {
        format!("{bytes}B")
    }
}

fn render_doctor_human(report: &DoctorReport) -> String {
    use std::fmt::Write;

    let mut out = String::new();
    let _ = writeln!(
        out,
        "Doctor summary: {} ok, {} warning(s), {} failed",
        report
            .items
            .len()
            .saturating_sub(report.warnings + report.failures),
        report.warnings,
        report.failures
    );
    let _ = writeln!(out, "CLI version: {}", report.cli_version);
    if let Some(binary_path) = report.binary_path.as_deref() {
        let _ = writeln!(out, "Binary:      {binary_path}");
    }
    if let Some(endpoint) = report.endpoint.value.as_deref() {
        match report.endpoint.source.as_deref() {
            Some(source) => {
                let _ = writeln!(out, "Endpoint:    {endpoint} ({source})");
            }
            None => {
                let _ = writeln!(out, "Endpoint:    {endpoint}");
            }
        }
    }
    let _ = writeln!(out);

    for check in &report.items {
        let _ = writeln!(
            out,
            "[{}] {}: {}",
            check.status.label(),
            check.title,
            sanitize_display(&check.summary)
        );
        if let Some(detail) = check.detail.as_deref() {
            let _ = writeln!(out, "      {}", sanitize_display(detail));
        }
    }

    out
}

fn render_active_connections_human(value: &Value) -> String {
    use std::fmt::Write;

    let mut out = String::new();
    let items = value
        .as_array()
        .map(|array| array.as_slice())
        .unwrap_or(&[]);
    if items.is_empty() {
        let _ = writeln!(out, "No active SSH connections");
        return out;
    }

    let _ = writeln!(
        out,
        "  {:<14} {:<24} {:<6} {:<10} {:<10} {:<4} {}",
        "ID", "HOST", "PORT", "USER", "STATE", "REFS", "KEEPALIVE"
    );
    for item in items {
        let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("-");
        let short_id = if id.len() > 12 { &id[..12] } else { id };
        let host = item.get("host").and_then(|v| v.as_str()).unwrap_or("-");
        let port = item.get("port").and_then(|v| v.as_u64()).unwrap_or(22);
        let user = item.get("username").and_then(|v| v.as_str()).unwrap_or("-");
        let state = item.get("state").and_then(|v| v.as_str()).unwrap_or("-");
        let refs = item.get("refCount").and_then(|v| v.as_u64()).unwrap_or(0);
        let keep_alive = item
            .get("keepAlive")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let _ = writeln!(
            out,
            "  {:<14} {:<24} {:<6} {:<10} {:<10} {:<4} {}",
            short_id,
            sanitize_display(host),
            port,
            sanitize_display(user),
            state,
            refs,
            if keep_alive { "yes" } else { "no" }
        );
    }

    out
}

fn render_session_inspect_human(value: &Value) -> String {
    use std::fmt::Write;

    let mut out = String::new();
    let session = value.get("session").unwrap_or(&Value::Null);
    let name = session.get("name").and_then(|v| v.as_str()).unwrap_or("-");
    let session_id = session.get("id").and_then(|v| v.as_str()).unwrap_or("-");
    let host = session.get("host").and_then(|v| v.as_str()).unwrap_or("-");
    let port = session.get("port").and_then(|v| v.as_u64()).unwrap_or(22);
    let user = session
        .get("username")
        .and_then(|v| v.as_str())
        .unwrap_or("-");
    let state = session.get("state").and_then(|v| v.as_str()).unwrap_or("-");
    let uptime = session
        .get("uptime_secs")
        .and_then(|v| v.as_u64())
        .map(format_duration)
        .unwrap_or_else(|| "-".to_string());
    let connection_id = session
        .get("connection_id")
        .and_then(|v| v.as_str())
        .unwrap_or("-");

    let _ = writeln!(out, "{}", sanitize_display(name));
    let _ = writeln!(out, "  Session:    {session_id}");
    let _ = writeln!(out, "  Host:       {}:{port}", sanitize_display(host));
    let _ = writeln!(out, "  User:       {}", sanitize_display(user));
    let _ = writeln!(out, "  State:      {state}");
    let _ = writeln!(out, "  Uptime:     {uptime}");
    let _ = writeln!(out, "  Connection: {connection_id}");

    match value.get("connection") {
        Some(Value::Object(connection)) => {
            let pool_id = connection.get("id").and_then(|v| v.as_str()).unwrap_or("-");
            let pool_state = connection
                .get("state")
                .and_then(|v| v.as_str())
                .unwrap_or("-");
            let ref_count = connection
                .get("refCount")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let keep_alive = connection
                .get("keepAlive")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let last_active = connection
                .get("lastActive")
                .and_then(|v| v.as_str())
                .unwrap_or("-");
            let _ = writeln!(
                out,
                "  Pool:       {} ({}, refs {}, keep-alive {})",
                pool_id,
                pool_state,
                ref_count,
                if keep_alive { "on" } else { "off" }
            );
            let _ = writeln!(out, "  Last seen:  {last_active}");
        }
        _ if connection_id != "-" => {
            let _ = writeln!(
                out,
                "  Pool:       not currently present in active connection list"
            );
        }
        _ => {}
    }

    match value.get("health") {
        Some(Value::Object(health)) => {
            let status = health
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            let latency = health
                .get("latency_ms")
                .and_then(|v| v.as_u64())
                .map(|ms| format!("{ms}ms"))
                .unwrap_or_else(|| "-".to_string());
            let message = health
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("-");
            let _ = writeln!(out, "  Health:     {status} ({latency})");
            let _ = writeln!(out, "  Message:    {}", sanitize_display(message));
        }
        _ => {
            if let Some(error) = value.get("health_error").and_then(|v| v.as_str()) {
                let _ = writeln!(out, "  Health:     unavailable");
                let _ = writeln!(out, "  Message:    {}", sanitize_display(error));
            } else {
                let _ = writeln!(out, "  Health:     unavailable");
            }
        }
    }

    let forwards = value
        .get("forwards")
        .and_then(|v| v.as_array())
        .map(|array| array.as_slice())
        .unwrap_or(&[]);
    if forwards.is_empty() {
        let _ = writeln!(out, "  Forwards:   none");
    } else {
        let _ = writeln!(out, "  Forwards:   {}", forwards.len());
        for forward in forwards {
            let bind_address = forward
                .get("bind_address")
                .and_then(|v| v.as_str())
                .unwrap_or("0.0.0.0");
            let bind_port = forward
                .get("bind_port")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let forward_type = forward
                .get("forward_type")
                .and_then(|v| v.as_str())
                .unwrap_or("-");
            let target = if forward_type == "dynamic" {
                "SOCKS5".to_string()
            } else {
                format!(
                    "{}:{}",
                    forward
                        .get("target_host")
                        .and_then(|v| v.as_str())
                        .unwrap_or("-"),
                    forward
                        .get("target_port")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0)
                )
            };
            let status = forward
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("-");
            let description = forward
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let _ = writeln!(
                out,
                "    - {} {}:{} → {} [{}] {}",
                forward_type,
                bind_address,
                bind_port,
                target,
                status,
                sanitize_display(description)
            );
        }
    }

    out
}

fn render_exec_result_human(value: &Value) -> String {
    use std::fmt::Write;

    let mut out = String::new();
    let shell = value
        .get("shell_target")
        .and_then(|v| v.as_str())
        .or_else(|| value.pointer("/plan/shell").and_then(|v| v.as_str()))
        .unwrap_or("bash");
    let summary = value
        .pointer("/plan/summary")
        .and_then(|v| v.as_str())
        .unwrap_or_else(|| value.get("text").and_then(|v| v.as_str()).unwrap_or(""));
    let prerequisites = value
        .pointer("/plan/prerequisites")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let risks = value
        .pointer("/plan/risks")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let notes = value
        .pointer("/plan/notes")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let commands = value
        .pointer("/plan/commands")
        .and_then(|v| v.as_array())
        .map(|items| items.as_slice())
        .unwrap_or(&[]);

    let _ = writeln!(out, "Exec plan ({shell})");
    if !summary.is_empty() {
        let _ = writeln!(out, "  Summary:    {}", sanitize_display(summary));
    }

    if !prerequisites.is_empty() {
        let _ = writeln!(out, "  Prerequisites:");
        for item in prerequisites {
            let _ = writeln!(out, "    - {}", sanitize_display(item));
        }
    }

    if !risks.is_empty() {
        let _ = writeln!(out, "  Risk warnings:");
        for item in risks {
            let _ = writeln!(out, "    - {}", sanitize_display(item));
        }
    }

    if !commands.is_empty() {
        let _ = writeln!(out, "  Commands:");
        for command in commands {
            let cmd = command
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let description = command
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if !description.is_empty() {
                let _ = writeln!(out, "    # {}", sanitize_display(description));
            }
            write_sanitized_multiline_block(&mut out, "    ", cmd.trim_end_matches('\n'));
        }
    }

    if !notes.is_empty() {
        let _ = writeln!(out, "  Notes:");
        for item in notes {
            let _ = writeln!(out, "    - {}", sanitize_display(item));
        }
    }

    out
}

fn write_sanitized_multiline_block(out: &mut String, indent: &str, text: &str) {
    use std::fmt::Write;

    let sanitized = sanitize_multiline_display(text);
    for line in sanitized.lines() {
        let _ = writeln!(out, "{indent}{line}");
    }

    if sanitized.ends_with('\n') {
        let _ = writeln!(out, "{indent}");
    }
}

#[cfg(test)]
mod tests {
    use super::{
        render_active_connections_human, render_doctor_human, render_exec_result_human,
        render_session_inspect_human,
    };
    use crate::{DoctorCheck, DoctorEndpoint, DoctorReport, DoctorStatus};
    use serde_json::json;

    #[test]
    fn doctor_renderer_includes_summary_and_details() {
        let report = DoctorReport {
            ok: false,
            cli_version: "1.2.5",
            binary_path: Some("/tmp/oxt".to_string()),
            endpoint: DoctorEndpoint {
                value: Some("/tmp/oxt.sock".to_string()),
                source: Some("CLI flag (--socket)".to_string()),
            },
            warnings: 1,
            failures: 1,
            items: vec![
                DoctorCheck {
                    id: "path_lookup",
                    title: "PATH lookup",
                    status: DoctorStatus::Warn,
                    summary: "oxt was not found in PATH".to_string(),
                    detail: Some("Expected install path: /Users/test/.local/bin/oxt".to_string()),
                },
                DoctorCheck {
                    id: "gui_connectivity",
                    title: "GUI connectivity",
                    status: DoctorStatus::Fail,
                    summary: "Failed to connect to the OxideTerm GUI".to_string(),
                    detail: Some("socket not found".to_string()),
                },
            ],
        };

        let rendered = render_doctor_human(&report);

        assert!(rendered.contains("Doctor summary: 0 ok, 1 warning(s), 1 failed"));
        assert!(rendered.contains("Endpoint:    /tmp/oxt.sock (CLI flag (--socket))"));
        assert!(rendered.contains("[warn] PATH lookup: oxt was not found in PATH"));
        assert!(
            rendered.contains("[fail] GUI connectivity: Failed to connect to the OxideTerm GUI")
        );
        assert!(rendered.contains("Expected install path"));
    }

    #[test]
    fn active_connections_renderer_includes_ref_count_and_keepalive() {
        let rendered = render_active_connections_human(&json!([
            {
                "id": "conn-1234567890ab",
                "host": "example.com",
                "port": 22,
                "username": "deploy",
                "state": "active",
                "refCount": 2,
                "keepAlive": true
            }
        ]));

        assert!(rendered.contains("example.com"));
        assert!(rendered.contains("deploy"));
        assert!(rendered.contains("2"));
        assert!(rendered.contains("yes"));
    }

    #[test]
    fn session_inspect_renderer_includes_session_pool_health_and_forwards() {
        let rendered = render_session_inspect_human(&json!({
            "session": {
                "id": "session-1",
                "connection_id": "conn-1",
                "name": "prod",
                "host": "example.com",
                "port": 22,
                "username": "deploy",
                "state": "active",
                "uptime_secs": 125
            },
            "connection": {
                "id": "conn-1",
                "state": "active",
                "refCount": 2,
                "keepAlive": true,
                "lastActive": "2026-04-19T12:00:00Z"
            },
            "health": {
                "status": "healthy",
                "latency_ms": 42,
                "message": "Connected • 42ms"
            },
            "forwards": [
                {
                    "forward_type": "local",
                    "bind_address": "127.0.0.1",
                    "bind_port": 8080,
                    "target_host": "localhost",
                    "target_port": 80,
                    "status": "active",
                    "description": "Web"
                }
            ]
        }));

        assert!(rendered.contains("prod"));
        assert!(rendered.contains("Pool:       conn-1 (active, refs 2, keep-alive on)"));
        assert!(rendered.contains("Health:     healthy (42ms)"));
        assert!(rendered.contains("Forwards:   1"));
        assert!(rendered.contains("127.0.0.1:8080"));
    }

    #[test]
    fn exec_renderer_includes_summary_commands_and_risks() {
        let rendered = render_exec_result_human(&json!({
            "shell_target": "bash",
            "plan": {
                "summary": "Rotate logs and keep seven archives.",
                "prerequisites": ["logrotate installed"],
                "risks": ["This overwrites existing rotated files."],
                "commands": [
                    {
                        "command": "logrotate -f /etc/logrotate.d/app",
                        "description": "Force a manual rotation"
                    }
                ],
                "notes": ["Review the generated config before execution."]
            }
        }));

        assert!(rendered.contains("Exec plan (bash)"));
        assert!(rendered.contains("Rotate logs and keep seven archives."));
        assert!(rendered.contains("Risk warnings:"));
        assert!(rendered.contains("logrotate -f /etc/logrotate.d/app"));
    }

    #[test]
    fn exec_renderer_preserves_multiline_command_blocks() {
        let rendered = render_exec_result_human(&json!({
            "shell_target": "bash",
            "plan": {
                "summary": "Create a script.",
                "prerequisites": [],
                "risks": [],
                "commands": [
                    {
                        "command": "cat <<'EOF' > script.sh\necho first\necho second\nEOF",
                        "description": "Write the script"
                    }
                ],
                "notes": []
            }
        }));

        assert!(
            rendered.contains("cat <<'EOF' > script.sh\n    echo first\n    echo second\n    EOF")
        );
    }

    #[test]
    fn exec_renderer_drops_carriage_returns_from_multiline_commands() {
        let rendered = render_exec_result_human(&json!({
            "shell_target": "bash",
            "plan": {
                "summary": "Create a script.",
                "prerequisites": [],
                "risks": [],
                "commands": [
                    {
                        "command": "printf 'safe'\rmalicious-overwrite",
                        "description": "Render safely"
                    }
                ],
                "notes": []
            }
        }));

        assert!(!rendered.contains('\r'));
        assert!(rendered.contains("printf 'safe'malicious-overwrite"));
    }
}
