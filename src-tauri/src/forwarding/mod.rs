// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

//! Port Forwarding Module
//!
//! Provides local, remote, and dynamic port forwarding for SSH connections.
//! Designed for HPC/supercomputing workflows (Jupyter, TensorBoard, etc.)

mod bridge;
mod dynamic;
mod events;
mod local;
pub mod manager;
pub mod remote;

pub use dynamic::{DynamicForward, DynamicForwardHandle, start_dynamic_forward};
pub use events::{ForwardEvent, ForwardEventEmitter};
pub use local::{LocalForward, LocalForwardHandle, start_local_forward};
pub use manager::{
    ForwardRule, ForwardRuleUpdate, ForwardStats, ForwardStatus, ForwardType, ForwardingManager,
};
pub use remote::{RemoteForward, RemoteForwardHandle, RemoteForwardRegistry, start_remote_forward};
