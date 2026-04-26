// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

//! JSON-RPC 2.0 protocol types for CLI ↔ GUI communication.
//!
//! Wire format: newline-delimited JSON (consistent with agent protocol).

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Incoming JSON-RPC request from the CLI.
#[derive(Debug, Deserialize)]
pub struct Request {
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

/// Outgoing JSON-RPC response to the CLI.
#[derive(Debug, Serialize)]
pub struct Response {
    pub id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

/// JSON-RPC error object.
#[derive(Debug, Serialize)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
}

/// Server-initiated notification (no `id`). Used for streaming responses.
#[derive(Debug, Serialize)]
pub struct Notification {
    pub method: String,
    pub params: Value,
}

impl Response {
    pub fn ok(id: u64, result: Value) -> Self {
        Self {
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn err(id: u64, code: i32, message: impl Into<String>) -> Self {
        Self {
            id,
            result: None,
            error: Some(RpcError {
                code,
                message: message.into(),
            }),
        }
    }
}

// Standard JSON-RPC error codes
pub const ERR_INVALID_REQUEST: i32 = -32600;
pub const ERR_METHOD_NOT_FOUND: i32 = -32601;
pub const ERR_INVALID_PARAMS: i32 = -32602;
pub const ERR_INTERNAL: i32 = -32603;

// Application error codes
pub const ERR_NOT_CONNECTED: i32 = 1001;
