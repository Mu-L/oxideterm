// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

//! Application diagnostics commands.
//!
//! These commands are intentionally read-only. They must not create SSH sessions,
//! local PTYs, SFTP handles, or long-running probes.

use serde::Serialize;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

use crate::commands::local::LocalTerminalState;
use crate::session::{BufferStats, SessionRegistry};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessMemoryDiagnostics {
    pub rss_bytes: Option<u64>,
    pub virtual_bytes: Option<u64>,
    pub thread_count: Option<usize>,
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalBufferDiagnostics {
    pub session_id: String,
    pub terminal_type: String,
    pub current_lines: usize,
    pub total_lines: u64,
    pub max_lines: usize,
    pub memory_usage_mb: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDiagnosticsSnapshot {
    pub captured_at: u64,
    pub process: ProcessMemoryDiagnostics,
    pub remote_session_count: usize,
    pub local_terminal_count: usize,
    pub scroll_buffers: Vec<TerminalBufferDiagnostics>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn read_process_memory() -> ProcessMemoryDiagnostics {
    let pid = match sysinfo::get_current_pid() {
        Ok(pid) => pid,
        Err(error) => {
            return ProcessMemoryDiagnostics {
                rss_bytes: None,
                virtual_bytes: None,
                thread_count: None,
                unavailable_reason: Some(format!("failed to read current pid: {}", error)),
            };
        }
    };

    let mut system = sysinfo::System::new_all();
    system.refresh_all();

    match system.process(pid) {
        Some(process) => ProcessMemoryDiagnostics {
            rss_bytes: Some(process.memory()),
            virtual_bytes: Some(process.virtual_memory()),
            thread_count: None,
            unavailable_reason: None,
        },
        None => ProcessMemoryDiagnostics {
            rss_bytes: None,
            virtual_bytes: None,
            thread_count: None,
            unavailable_reason: Some("current process is not available from sysinfo".to_string()),
        },
    }
}

fn buffer_diagnostics(
    session_id: String,
    terminal_type: &'static str,
    stats: BufferStats,
) -> TerminalBufferDiagnostics {
    TerminalBufferDiagnostics {
        session_id,
        terminal_type: terminal_type.to_string(),
        current_lines: stats.current_lines,
        total_lines: stats.total_lines,
        max_lines: stats.max_lines,
        memory_usage_mb: stats.memory_usage_mb,
    }
}

#[tauri::command]
pub async fn get_memory_diagnostics(
    registry: State<'_, Arc<SessionRegistry>>,
    local_state: State<'_, Arc<LocalTerminalState>>,
) -> Result<MemoryDiagnosticsSnapshot, String> {
    let mut scroll_buffers = Vec::new();

    for session in registry.list() {
        let Some(scroll_buffer) = registry.with_session(&session.id, |entry| entry.scroll_buffer.clone()) else {
            continue;
        };
        let stats = scroll_buffer.stats().await;
        scroll_buffers.push(buffer_diagnostics(session.id, "remote", stats));
    }

    let local_terminals = local_state.registry.list_sessions().await;
    for terminal in &local_terminals {
        if let Ok(stats) = local_state.registry.get_buffer_stats(&terminal.id).await {
            scroll_buffers.push(buffer_diagnostics(terminal.id.clone(), "local", stats));
        }
    }

    Ok(MemoryDiagnosticsSnapshot {
        captured_at: now_ms(),
        process: read_process_memory(),
        remote_session_count: registry.count(),
        local_terminal_count: local_terminals.len(),
        scroll_buffers,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buffer_diagnostics_preserves_scroll_buffer_stats() {
        let stats = BufferStats {
            current_lines: 120,
            total_lines: 420,
            max_lines: 8000,
            memory_usage_mb: 1.25,
        };

        let diagnostics = buffer_diagnostics("session-1".to_string(), "remote", stats);

        assert_eq!(diagnostics.session_id, "session-1");
        assert_eq!(diagnostics.terminal_type, "remote");
        assert_eq!(diagnostics.current_lines, 120);
        assert_eq!(diagnostics.total_lines, 420);
        assert_eq!(diagnostics.max_lines, 8000);
        assert_eq!(diagnostics.memory_usage_mb, 1.25);
    }

    #[test]
    fn read_process_memory_reports_values_or_unavailable_reason() {
        let diagnostics = read_process_memory();

        assert!(
            diagnostics.rss_bytes.is_some() || diagnostics.unavailable_reason.is_some(),
            "process memory diagnostics should either report RSS or explain why it is unavailable"
        );
        assert!(
            diagnostics.virtual_bytes.is_some() || diagnostics.unavailable_reason.is_some(),
            "process memory diagnostics should either report virtual memory or explain why it is unavailable"
        );
    }
}
