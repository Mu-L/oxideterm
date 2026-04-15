// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

//! Keyboard-Interactive response commands.
//!
//! Standalone and chained KBI prompts are emitted from the SSH auth flow.
//! The frontend responds through these Tauri commands.

use crate::ssh::keyboard_interactive::{
    KbiCancelRequest, KbiRespondRequest, cancel_pending, complete_pending,
};
use tauri::command;
use tracing::{debug, warn};

/// Respond to a keyboard-interactive prompt.
#[command]
pub async fn ssh_kbi_respond(request: KbiRespondRequest) -> Result<(), String> {
    debug!(
        "KBI respond for flow {}: {} responses",
        request.auth_flow_id,
        request.responses.len()
    );
    complete_pending(&request.auth_flow_id, request.responses).map_err(|e| e.to_string())
}

/// Cancel a keyboard-interactive authentication flow.
#[command]
pub async fn ssh_kbi_cancel(request: KbiCancelRequest) -> Result<(), String> {
    warn!("KBI cancel requested for flow {}", request.auth_flow_id);
    cancel_pending(&request.auth_flow_id).map_err(|e| e.to_string())
}
