// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

//! Remote Port Forwarding
//!
//! Forwards connections from a remote port back to a local host:port through SSH.
//! Example: Remote server:9000 -> local:3000 (expose local service to remote)
//!
//! ## Architecture
//!
//! Remote forwarding requires coordination between:
//! 1. The SSH client (sends `tcpip-forward` request via HandleController)
//! 2. The SSH server (listens on remote port)
//! 3. The ClientHandler callback (handles incoming `forwarded-tcpip` channels)
//!
//! We use a global registry to store the mapping from (address, port) -> local target,
//! which the ClientHandler can look up when it receives a forwarded connection.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use std::sync::LazyLock;
use tokio::net::TcpStream;
use tokio::sync::{RwLock, broadcast, mpsc};
use tracing::{debug, info, warn};

use super::bridge::{ActiveConnectionCounter, BridgeStatsRecorder, bridge_stream_to_ssh_channel};
use super::events::ForwardEventEmitter;
use super::manager::ForwardStatus;
use crate::ssh::{HandleController, SshError};

/// Forward statistics
#[derive(Debug, Clone, Default)]
pub struct ForwardStats {
    /// Total connection count
    pub connection_count: u64,
    /// Currently active connections
    pub active_connections: u64,
    /// Total bytes sent (to remote)
    pub bytes_sent: u64,
    /// Total bytes received (from remote)
    pub bytes_received: u64,
}

/// Remote port forwarding configuration
#[derive(Debug, Clone)]
pub struct RemoteForward {
    /// Remote bind address (e.g., "0.0.0.0" or "localhost")
    pub remote_addr: String,
    /// Remote port to bind on the server
    pub remote_port: u16,
    /// Local host to connect to (e.g., "localhost")
    pub local_host: String,
    /// Local port to connect to
    pub local_port: u16,
    /// Description for UI display
    pub description: Option<String>,
}

impl RemoteForward {
    /// Create a new remote port forward
    pub fn new(
        remote_addr: impl Into<String>,
        remote_port: u16,
        local_host: impl Into<String>,
        local_port: u16,
    ) -> Self {
        Self {
            remote_addr: remote_addr.into(),
            remote_port,
            local_host: local_host.into(),
            local_port,
            description: None,
        }
    }

    /// Create a simple remote forward from remote port to local port
    pub fn simple(remote_port: u16, local_port: u16) -> Self {
        Self {
            remote_addr: "localhost".into(),
            remote_port,
            local_host: "localhost".into(),
            local_port,
            description: None,
        }
    }

    /// Set description
    pub fn with_description(mut self, desc: impl Into<String>) -> Self {
        self.description = Some(desc.into());
        self
    }
}

/// Target configuration for a remote forward
#[derive(Debug, Clone)]
pub struct RemoteForwardTarget {
    pub local_host: String,
    pub local_port: u16,
    /// Stats tracking using atomics for lock-free updates from async handlers
    pub stats: Arc<RemoteForwardStatsAtomic>,
}

/// Atomic stats for remote forwards (used for thread-safe updates from callbacks)
#[derive(Debug, Default)]
pub struct RemoteForwardStatsAtomic {
    pub connection_count: AtomicU64,
    pub active_connections: ActiveConnectionCounter,
    pub bytes_sent: AtomicU64,
    pub bytes_received: AtomicU64,
}

impl RemoteForwardStatsAtomic {
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

impl BridgeStatsRecorder for RemoteForwardStatsAtomic {
    fn record_bytes_sent(&self, bytes: u64) {
        self.bytes_sent.fetch_add(bytes, Ordering::Relaxed);
    }

    fn record_bytes_received(&self, bytes: u64) {
        self.bytes_received.fetch_add(bytes, Ordering::Relaxed);
    }
}

/// Global registry for remote forward configurations
///
/// This registry maps (remote_address, remote_port) -> local target.
/// It's used by the ClientHandler to look up where to connect when
/// a forwarded-tcpip channel is opened by the server.
pub struct RemoteForwardRegistry {
    /// Map from (address, port) to local target
    forwards: RwLock<HashMap<String, HashMap<u16, RemoteForwardTarget>>>,
}

impl RemoteForwardRegistry {
    /// Create a new registry
    pub fn new() -> Self {
        Self {
            forwards: RwLock::new(HashMap::new()),
        }
    }

    /// Register a remote forward
    pub async fn register(
        &self,
        remote_addr: String,
        remote_port: u16,
        local_host: String,
        local_port: u16,
    ) -> Arc<RemoteForwardStatsAtomic> {
        let stats = Arc::new(RemoteForwardStatsAtomic::new());
        let target = RemoteForwardTarget {
            local_host,
            local_port,
            stats: stats.clone(),
        };
        self.forwards
            .write()
            .await
            .entry(remote_addr.clone())
            .or_default()
            .insert(remote_port, target);
        debug!(
            "Registered remote forward: {}:{} -> target",
            remote_addr, remote_port
        );
        stats
    }

    /// Unregister a remote forward
    pub async fn unregister(&self, remote_addr: &str, remote_port: u16) {
        let mut forwards = self.forwards.write().await;
        if let Some(ports) = forwards.get_mut(remote_addr) {
            ports.remove(&remote_port);
            if ports.is_empty() {
                forwards.remove(remote_addr);
            }
        }
        debug!(
            "Unregistered remote forward: {}:{}",
            remote_addr, remote_port
        );
    }

    /// Look up a remote forward target
    pub async fn lookup(&self, remote_addr: &str, remote_port: u16) -> Option<RemoteForwardTarget> {
        self.forwards
            .read()
            .await
            .get(remote_addr)
            .and_then(|ports| ports.get(&remote_port))
            .cloned()
    }

    /// Check if a forward exists
    #[allow(dead_code)]
    pub async fn exists(&self, remote_addr: &str, remote_port: u16) -> bool {
        self.forwards
            .read()
            .await
            .get(remote_addr)
            .is_some_and(|ports| ports.contains_key(&remote_port))
    }
}

impl Default for RemoteForwardRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Global instance of the remote forward registry
pub static REMOTE_FORWARD_REGISTRY: LazyLock<RemoteForwardRegistry> =
    LazyLock::new(RemoteForwardRegistry::new);

/// Handle to a running remote port forward
pub struct RemoteForwardHandle {
    /// Forward configuration
    pub config: RemoteForward,
    /// Actual bound port on the server (may differ if original was 0)
    pub bound_port: u16,
    /// Flag to indicate if running
    running: Arc<AtomicBool>,
    /// Channel to signal stop
    stop_tx: mpsc::Sender<()>,
    /// Handle controller for cancellation
    handle_controller: HandleController,
    /// Stats tracking
    stats: Arc<RemoteForwardStatsAtomic>,
}

impl RemoteForwardHandle {
    /// Stop the port forwarding and wait for cleanup
    pub async fn stop(&self) {
        info!(
            "Stopping remote port forward {}:{}",
            self.config.remote_addr, self.bound_port
        );
        self.running.store(false, Ordering::Release);

        // Cancel the forward on the server via Handle Owner Task
        if let Err(e) = self
            .handle_controller
            .cancel_tcpip_forward(&self.config.remote_addr, self.bound_port as u32)
            .await
        {
            warn!("Failed to cancel remote forward: {:?}", e);
        }

        // Unregister from the global registry
        REMOTE_FORWARD_REGISTRY
            .unregister(&self.config.remote_addr, self.bound_port)
            .await;

        let _ = self.stop_tx.send(()).await;

        let timeout = std::time::Duration::from_secs(5);
        if !self.stats.active_connections.wait_for_zero(timeout).await {
            warn!(
                "Timeout waiting for {} active connections to close on {}:{}",
                self.stats.active_connections.load(),
                self.config.remote_addr,
                self.bound_port
            );
        }
    }

    /// Check if the forward is still running
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::Acquire)
    }

    /// Get current stats
    pub fn stats(&self) -> ForwardStats {
        self.stats.to_stats()
    }
}

/// Start remote port forwarding
///
/// This function:
/// 1. Sends a tcpip-forward request to the SSH server via Handle Owner Task
/// 2. Registers the forward in the global registry
/// 3. Returns a handle that can be used to stop the forward
///
/// The actual forwarding happens in the ClientHandler callback when
/// the server opens a forwarded-tcpip channel.
pub async fn start_remote_forward(
    handle_controller: HandleController,
    config: RemoteForward,
) -> Result<RemoteForwardHandle, SshError> {
    // Subscribe to disconnect notifications
    let disconnect_rx = handle_controller.subscribe_disconnect();
    start_remote_forward_with_disconnect(handle_controller, config, disconnect_rx, None, None).await
}

/// Start remote forward with explicit disconnect receiver and optional event emitter
pub async fn start_remote_forward_with_disconnect(
    handle_controller: HandleController,
    config: RemoteForward,
    mut disconnect_rx: broadcast::Receiver<()>,
    forward_id: Option<String>,
    event_emitter: Option<ForwardEventEmitter>,
) -> Result<RemoteForwardHandle, SshError> {
    info!(
        "Requesting remote port forward: {}:{} -> {}:{}",
        config.remote_addr, config.remote_port, config.local_host, config.local_port
    );

    // Request the server to listen on the remote port via Handle Owner Task
    // The tcpip_forward is called through message passing, avoiding &mut Handle issues
    let actual_port = handle_controller
        .tcpip_forward(&config.remote_addr, config.remote_port as u32)
        .await?;

    info!(
        "Remote forward established: {}:{} (requested {}) -> {}:{}",
        config.remote_addr, actual_port, config.remote_port, config.local_host, config.local_port
    );

    // Register in the global registry so ClientHandler can find the target
    // This also returns the stats Arc for tracking
    let stats = REMOTE_FORWARD_REGISTRY
        .register(
            config.remote_addr.clone(),
            actual_port as u16,
            config.local_host.clone(),
            config.local_port,
        )
        .await;

    let running = Arc::new(AtomicBool::new(true));
    let (stop_tx, mut stop_rx) = mpsc::channel::<()>(1);
    let running_clone = running.clone();
    let remote_addr_clone = config.remote_addr.clone();
    let bound_port_clone = actual_port as u16;

    // Spawn a monitoring task that listens for stop signal or SSH disconnect
    tokio::spawn(async move {
        enum ExitReason {
            StopRequested,
            SshDisconnected,
        }

        let exit_reason = tokio::select! {
            _ = stop_rx.recv() => {
                info!("Remote port forward stopped by request");
                ExitReason::StopRequested
            }
            _ = disconnect_rx.recv() => {
                info!("Remote port forward stopped: SSH disconnected");
                ExitReason::SshDisconnected
            }
        };
        running_clone.store(false, Ordering::Release);

        // Unregister from registry on exit
        REMOTE_FORWARD_REGISTRY
            .unregister(&remote_addr_clone, bound_port_clone)
            .await;

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
                ExitReason::StopRequested => {
                    // Stopped by user request, manager already handles this
                }
            }
        }

        info!("Remote port forward monitor task exited");
    });

    Ok(RemoteForwardHandle {
        config,
        bound_port: actual_port as u16,
        running,
        stop_tx,
        handle_controller,
        stats,
    })
}

/// Handle a forwarded connection from the remote server.
///
/// This is called by the ClientHandler when the server opens a forwarded-tcpip channel.
/// It looks up the target in the global registry and bridges the connection.
pub async fn handle_forwarded_connection(
    channel: russh::Channel<russh::client::Msg>,
    connected_address: &str,
    connected_port: u32,
    originator_address: &str,
    originator_port: u32,
) -> Result<(), SshError> {
    debug!(
        "Handling forwarded connection: {}:{} from {}:{}",
        connected_address, connected_port, originator_address, originator_port
    );

    // Look up the target from the registry
    let target = REMOTE_FORWARD_REGISTRY
        .lookup(connected_address, connected_port as u16)
        .await
        .ok_or_else(|| {
            SshError::ConnectionFailed(format!(
                "No registered forward for {}:{}",
                connected_address, connected_port
            ))
        })?;

    // Update connection stats
    target
        .stats
        .connection_count
        .fetch_add(1, Ordering::Relaxed);
    target.stats.active_connections.increment();
    let stats = target.stats.clone();

    // Connect to local service
    let local_addr = format!("{}:{}", target.local_host, target.local_port);
    let local_stream = TcpStream::connect(&local_addr).await.map_err(|e| {
        // Decrement active connections on connection failure
        stats.active_connections.decrement();
        SshError::ConnectionFailed(format!("Failed to connect to {}: {}", local_addr, e))
    })?;

    // Disable Nagle's algorithm for low-latency forwarding
    if let Err(e) = local_stream.set_nodelay(true) {
        warn!("Failed to set TCP_NODELAY: {}", e);
    }

    info!(
        "Bridging forwarded connection {}:{} -> {}",
        connected_address, connected_port, local_addr
    );

    // Bridge the connection
    let result = bridge_forwarded_connection(local_stream, channel, stats.clone()).await;

    // Decrement active connections when done
    stats.active_connections.decrement();

    result
}

/// Idle timeout for remote forwarded connections (5 minutes)
const REMOTE_FORWARD_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// Bridge data between local socket and SSH channel
///
/// # Architecture: Lock-Free Channel I/O with Timeout Protection
///
/// Uses the same message-passing pattern as local.rs to avoid lock contention.
/// A single task owns the SSH Channel, communicating with read/write tasks via mpsc.
///
/// Key improvements over the original Arc<Mutex<Channel>> approach:
/// 1. No lock contention between concurrent read/write operations
/// 2. Explicit timeout on all I/O operations (protects against zombie connections)
/// 3. Clean shutdown propagation via broadcast channel
async fn bridge_forwarded_connection(
    local_stream: TcpStream,
    channel: russh::Channel<russh::client::Msg>,
    stats: Arc<RemoteForwardStatsAtomic>,
) -> Result<(), SshError> {
    bridge_stream_to_ssh_channel(
        local_stream,
        channel,
        stats,
        REMOTE_FORWARD_IDLE_TIMEOUT,
        None,
        "Remote forward",
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_remote_forward_simple() {
        let forward = RemoteForward::simple(9000, 3000);
        assert_eq!(forward.remote_port, 9000);
        assert_eq!(forward.local_port, 3000);
        assert_eq!(forward.local_host, "localhost");
    }

    #[test]
    fn test_remote_forward_with_description() {
        let forward = RemoteForward::simple(8080, 8080).with_description("Web Server");
        assert!(forward.description.unwrap().contains("Web Server"));
    }

    #[tokio::test]
    async fn test_registry() {
        let registry = RemoteForwardRegistry::new();

        // Register
        registry
            .register("0.0.0.0".to_string(), 9000, "localhost".to_string(), 3000)
            .await;

        // Lookup
        let target = registry.lookup("0.0.0.0", 9000).await;
        assert!(target.is_some());
        let target = target.unwrap();
        assert_eq!(target.local_host, "localhost");
        assert_eq!(target.local_port, 3000);

        // Unregister
        registry.unregister("0.0.0.0", 9000).await;
        assert!(registry.lookup("0.0.0.0", 9000).await.is_none());
    }

    #[tokio::test]
    async fn test_registry_keeps_other_ports_for_same_address() {
        let registry = RemoteForwardRegistry::new();

        registry
            .register("0.0.0.0".to_string(), 9000, "localhost".to_string(), 3000)
            .await;
        registry
            .register("0.0.0.0".to_string(), 9001, "localhost".to_string(), 3001)
            .await;

        registry.unregister("0.0.0.0", 9000).await;

        assert!(registry.lookup("0.0.0.0", 9000).await.is_none());
        let remaining = registry.lookup("0.0.0.0", 9001).await.unwrap();
        assert_eq!(remaining.local_port, 3001);
    }
}
