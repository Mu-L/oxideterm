// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

//! Local Port Forwarding
//!
//! Forwards connections from a local port to a remote host:port through SSH.
//! Example: Forward local:8888 -> remote_jupyter:8888

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, mpsc};
use tracing::{debug, error, info, warn};

use super::bridge::{ActiveConnectionCounter, BridgeStatsRecorder, bridge_stream_to_ssh_channel};
use super::events::ForwardEventEmitter;
use super::manager::ForwardStatus;
use crate::ssh::{HandleController, SshError};

/// Local port forwarding configuration
#[derive(Debug, Clone)]
pub struct LocalForward {
    /// Local address to bind to (e.g., "127.0.0.1:8888")
    pub local_addr: String,
    /// Remote host to connect to through SSH (e.g., "localhost")
    pub remote_host: String,
    /// Remote port to connect to
    pub remote_port: u16,
    /// Description for UI display
    pub description: Option<String>,
}

impl LocalForward {
    /// Create a new local port forward
    pub fn new(
        local_addr: impl Into<String>,
        remote_host: impl Into<String>,
        remote_port: u16,
    ) -> Self {
        Self {
            local_addr: local_addr.into(),
            remote_host: remote_host.into(),
            remote_port,
            description: None,
        }
    }

    /// Create a Jupyter notebook forward (common HPC use case)
    pub fn jupyter(local_port: u16, remote_port: u16) -> Self {
        Self {
            local_addr: format!("127.0.0.1:{}", local_port),
            remote_host: "localhost".into(),
            remote_port,
            description: Some(format!("Jupyter Notebook (port {})", remote_port)),
        }
    }

    /// Create a TensorBoard forward (common ML use case)
    pub fn tensorboard(local_port: u16, remote_port: u16) -> Self {
        Self {
            local_addr: format!("127.0.0.1:{}", local_port),
            remote_host: "localhost".into(),
            remote_port,
            description: Some(format!("TensorBoard (port {})", remote_port)),
        }
    }

    /// Set description
    pub fn with_description(mut self, desc: impl Into<String>) -> Self {
        self.description = Some(desc.into());
        self
    }
}

/// Statistics for a port forward
#[derive(Debug, Clone, Default)]
pub struct ForwardStats {
    /// Total connections handled
    pub connection_count: u64,
    /// Active connections right now
    pub active_connections: u64,
    /// Total bytes sent (client -> server)
    pub bytes_sent: u64,
    /// Total bytes received (server -> client)
    pub bytes_received: u64,
}

/// Atomic (lock-free) version of ForwardStats for concurrent updates
#[derive(Debug, Default)]
pub struct ForwardStatsAtomic {
    pub connection_count: AtomicU64,
    pub active_connections: ActiveConnectionCounter,
    pub bytes_sent: AtomicU64,
    pub bytes_received: AtomicU64,
}

impl ForwardStatsAtomic {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn to_stats(&self) -> ForwardStats {
        ForwardStats {
            connection_count: self.connection_count.load(Ordering::Relaxed),
            active_connections: self.active_connections.load(),
            bytes_sent: self.bytes_sent.load(Ordering::Relaxed),
            bytes_received: self.bytes_received.load(Ordering::Relaxed),
        }
    }
}

impl BridgeStatsRecorder for ForwardStatsAtomic {
    fn record_bytes_sent(&self, bytes: u64) {
        self.bytes_sent.fetch_add(bytes, Ordering::Relaxed);
    }

    fn record_bytes_received(&self, bytes: u64) {
        self.bytes_received.fetch_add(bytes, Ordering::Relaxed);
    }
}

/// Handle to a running local port forward
pub struct LocalForwardHandle {
    /// Forward configuration
    pub config: LocalForward,
    /// Actual bound address (may differ from requested if port was 0)
    pub bound_addr: SocketAddr,
    /// Flag to stop the forwarding loop
    running: Arc<AtomicBool>,
    /// Channel to signal stop
    stop_tx: mpsc::Sender<()>,
    /// Connection statistics
    stats: Arc<ForwardStatsAtomic>,
}

impl LocalForwardHandle {
    /// Stop the port forwarding and wait for active connections to close
    pub async fn stop(&self) {
        info!("Stopping local port forward on {}", self.bound_addr);
        self.running.store(false, Ordering::Release);
        let _ = self.stop_tx.send(()).await;

        let timeout = std::time::Duration::from_secs(5);
        if !self.stats.active_connections.wait_for_zero(timeout).await {
            warn!(
                "Timeout waiting for {} active connections to close on {}",
                self.stats.active_connections.load(),
                self.bound_addr
            );
        }
    }

    /// Check if the forward is still running
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::Acquire)
    }

    /// Get current statistics
    pub fn stats(&self) -> ForwardStats {
        self.stats.to_stats()
    }
}

/// Start local port forwarding
///
/// This function spawns a background task that:
/// 1. Listens on the local address
/// 2. For each incoming connection, opens a direct-tcpip channel through SSH
/// 3. Bridges data between the local socket and the SSH channel
///
/// Uses HandleController to communicate with Handle Owner Task for opening channels.
///
/// # Arguments
/// * `handle_controller` - Controller for SSH operations
/// * `config` - Forward configuration
/// * `disconnect_rx` - Receiver for SSH disconnect notification (optional for backward compat)
pub async fn start_local_forward(
    handle_controller: HandleController,
    config: LocalForward,
) -> Result<LocalForwardHandle, SshError> {
    // Subscribe to disconnect notifications
    let disconnect_rx = handle_controller.subscribe_disconnect();
    start_local_forward_with_disconnect(handle_controller, config, disconnect_rx, None, None).await
}

/// Start local port forwarding with explicit disconnect receiver
pub async fn start_local_forward_with_disconnect(
    handle_controller: HandleController,
    config: LocalForward,
    mut disconnect_rx: broadcast::Receiver<()>,
    forward_id: Option<String>,
    event_emitter: Option<ForwardEventEmitter>,
) -> Result<LocalForwardHandle, SshError> {
    // Bind to local address
    let listener = TcpListener::bind(&config.local_addr)
        .await
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::AddrInUse => SshError::ConnectionFailed(format!(
                "Port already in use: {}. Another application may be using this port.",
                config.local_addr
            )),
            std::io::ErrorKind::PermissionDenied => SshError::ConnectionFailed(format!(
                "Permission denied binding to {}. Ports below 1024 require elevated privileges.",
                config.local_addr
            )),
            std::io::ErrorKind::AddrNotAvailable => SshError::ConnectionFailed(format!(
                "Address not available: {}. The specified address is not valid on this system.",
                config.local_addr
            )),
            _ => SshError::ConnectionFailed(format!(
                "Failed to bind to {}: {}",
                config.local_addr, e
            )),
        })?;

    let bound_addr = listener
        .local_addr()
        .map_err(|e| SshError::ConnectionFailed(format!("Failed to get bound address: {}", e)))?;

    info!(
        "Started local port forward: {} -> {}:{}",
        bound_addr, config.remote_host, config.remote_port
    );

    let running = Arc::new(AtomicBool::new(true));
    let running_clone = running.clone();
    let (stop_tx, mut stop_rx) = mpsc::channel::<()>(1);
    let stats = Arc::new(ForwardStatsAtomic::new());
    let stats_clone = stats.clone();

    let remote_host = config.remote_host.clone();
    let remote_port = config.remote_port;

    // Create a broadcast channel for notifying child tasks of shutdown
    // This propagates the disconnect signal to all spawned connection handlers
    let (child_shutdown_tx, _) = broadcast::channel::<()>(16);
    let child_shutdown_tx_clone = child_shutdown_tx.clone();

    // Spawn the forwarding task
    tokio::spawn(async move {
        // Track exit reason for event emission
        #[allow(dead_code)]
        enum ExitReason {
            SshDisconnected,
            StopRequested,
            Error, // Reserved for future error handling
        }

        let exit_reason = loop {
            tokio::select! {
                // Handle SSH disconnect signal
                _ = disconnect_rx.recv() => {
                    info!("Local port forward stopped: SSH disconnected");
                    break ExitReason::SshDisconnected;
                }

                // Handle stop signal
                _ = stop_rx.recv() => {
                    info!("Local port forward stopped by request");
                    break ExitReason::StopRequested;
                }

                // Accept new connections
                accept_result = listener.accept() => {
                    match accept_result {
                        Ok((stream, peer_addr)) => {
                            if !running_clone.load(Ordering::Acquire) {
                                break ExitReason::StopRequested;
                            }

                            // Disable Nagle's algorithm for low-latency forwarding
                            if let Err(e) = stream.set_nodelay(true) {
                                warn!("Failed to set TCP_NODELAY: {}", e);
                            }

                            debug!("Accepted connection from {} for forward", peer_addr);

                            // Update stats
                            stats_clone.connection_count.fetch_add(1, Ordering::Relaxed);
                            stats_clone.active_connections.increment();

                            // Clone for the connection handler
                            let controller = handle_controller.clone();
                            let remote_host_clone = remote_host.clone();
                            let stats_for_conn = stats_clone.clone();
                            // Subscribe to shutdown signal for this child task
                            let child_shutdown_rx = child_shutdown_tx_clone.subscribe();

                            // Spawn a task to handle this connection
                            tokio::spawn(async move {
                                let result = handle_forward_connection(
                                    controller,
                                    stream,
                                    &remote_host_clone,
                                    remote_port,
                                    stats_for_conn.clone(),
                                    child_shutdown_rx,
                                ).await;

                                stats_for_conn.active_connections.decrement();

                                if let Err(e) = result {
                                    warn!("Forward connection error: {}", e);
                                }
                            });
                        }
                        Err(e) => {
                            error!("Accept error: {}", e);
                            // Small delay before retrying
                            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                        }
                    }
                }
            }
        };

        running_clone.store(false, Ordering::Release);

        // Signal all child tasks to shutdown
        // Ignore error if no receivers (all connections already closed)
        let _ = child_shutdown_tx.send(());

        // Emit status event based on exit reason
        if let (Some(emitter), Some(fwd_id)) = (&event_emitter, &forward_id) {
            match exit_reason {
                ExitReason::SshDisconnected => {
                    emitter.emit_status_changed(
                        fwd_id,
                        ForwardStatus::Suspended,
                        Some("SSH connection lost".into()),
                    );
                }
                ExitReason::Error => {
                    emitter.emit_status_changed(
                        fwd_id,
                        ForwardStatus::Error,
                        Some("Forward task error".into()),
                    );
                }
                ExitReason::StopRequested => {
                    // Stopped by user request, manager already handles this
                }
            }
        }

        info!("Local port forward task exited");
    });

    Ok(LocalForwardHandle {
        config,
        bound_addr,
        running,
        stop_tx,
        stats,
    })
}

/// Idle timeout for forwarded connections (5 minutes)
const FORWARD_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// Handle a single forwarded connection
///
/// # Architecture: Lock-Free Channel I/O
///
/// Instead of wrapping the russh Channel in `Arc<Mutex<Channel>>` (which causes lock contention
/// when both read and write tasks compete for the mutex), we use a message-passing approach:
///
/// 1. A dedicated "channel reader" task owns the Channel and reads from SSH
/// 2. Data flows through mpsc channels: local_read -> SSH, SSH -> local_write
/// 3. The shutdown signal propagates to all tasks via broadcast channel
///
/// This eliminates:
/// - Lock contention between read/write paths
/// - Potential deadlocks from holding locks across `.await`
/// - The need to manually manage lock ordering
async fn handle_forward_connection(
    handle_controller: HandleController,
    local_stream: TcpStream,
    remote_host: &str,
    remote_port: u16,
    stats: Arc<ForwardStatsAtomic>,
    shutdown_rx: broadcast::Receiver<()>,
) -> Result<(), SshError> {
    // Open direct-tcpip channel to remote via Handle Owner Task
    let channel = handle_controller
        .open_direct_tcpip(remote_host, remote_port as u32, "127.0.0.1", 0)
        .await?;

    debug!(
        "Opened channel for forward to {}:{}",
        remote_host, remote_port
    );

    bridge_stream_to_ssh_channel(
        local_stream,
        channel,
        stats,
        FORWARD_IDLE_TIMEOUT,
        Some(shutdown_rx),
        "Local forward",
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_jupyter_forward() {
        let forward = LocalForward::jupyter(8888, 8888);
        assert_eq!(forward.local_addr, "127.0.0.1:8888");
        assert_eq!(forward.remote_host, "localhost");
        assert_eq!(forward.remote_port, 8888);
        assert!(forward.description.unwrap().contains("Jupyter"));
    }

    #[test]
    fn test_tensorboard_forward() {
        let forward = LocalForward::tensorboard(6006, 6006);
        assert_eq!(forward.local_addr, "127.0.0.1:6006");
        assert_eq!(forward.remote_port, 6006);
        assert!(forward.description.unwrap().contains("TensorBoard"));
    }
}
