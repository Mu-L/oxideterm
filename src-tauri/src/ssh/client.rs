// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

//! SSH Client implementation using russh

use std::net::ToSocketAddrs;
use std::sync::Arc;
use std::time::Duration;

use russh::keys::PublicKey;
use russh::*;
use tracing::{debug, info, warn};

use super::auth::{
    DEFAULT_AUTH_TIMEOUT_SECS, authenticate_password, build_client_config, ensure_auth_success,
    load_certificate_auth_material, load_public_key_auth_material,
};
use super::config::{AuthMethod, SshConfig};
use super::error::SshError;
use super::known_hosts::{HostKeyVerification, get_known_hosts};
use super::session::SshSession;

/// SSH Client handler for russh
pub struct SshClient {
    config: SshConfig,
}

impl SshClient {
    pub fn new(config: SshConfig) -> Self {
        Self { config }
    }

    /// Connect to the SSH server and return a session
    pub async fn connect(self) -> Result<SshSession, SshError> {
        let addr = format!("{}:{}", self.config.host, self.config.port);

        info!("Connecting to SSH server at {}", addr);

        // Resolve address
        let socket_addr = addr
            .to_socket_addrs()
            .map_err(|e| SshError::ConnectionFailed(format!("Failed to resolve address: {}", e)))?
            .next()
            .ok_or_else(|| SshError::ConnectionFailed("No address found".to_string()))?;

        // SSH keepalive config (defense-in-depth):
        // Layer 1 (here): russh native keepalive — safety net in case app heartbeat stalls
        // Layer 2: App-level heartbeat (15s) in connection_registry — provides granular
        //          LinkDown events, smart probe confirmation, and frontend state updates
        let ssh_config = build_client_config();

        // Create SSH client handler with host info for key verification
        let handler = ClientHandler::with_trust(
            self.config.host.clone(),
            self.config.port,
            self.config.strict_host_key_checking,
            self.config.trust_host_key,
            self.config.agent_forwarding,
        );

        // Connect with timeout
        let mut handle = tokio::time::timeout(
            Duration::from_secs(self.config.timeout_secs),
            client::connect(Arc::new(ssh_config), socket_addr, handler),
        )
        .await
        .map_err(|_| SshError::Timeout("Connection timed out".to_string()))?
        .map_err(|e| SshError::ConnectionFailed(e.to_string()))?;

        debug!("SSH handshake completed");

        // Authenticate
        let authenticated = match &self.config.auth {
            AuthMethod::Password { password } => {
                authenticate_password(
                    &mut handle,
                    &self.config.username,
                    password,
                    DEFAULT_AUTH_TIMEOUT_SECS,
                    "Password authentication timed out",
                    "Password authentication timed out (retry)",
                    "Password auth",
                )
                .await?
            }
            AuthMethod::Key {
                key_path,
                passphrase,
            } => handle
                .authenticate_publickey(
                    &self.config.username,
                    load_public_key_auth_material(key_path, passphrase.as_deref())?,
                )
                .await
                .map_err(|e| SshError::AuthenticationFailed(e.to_string()))?,
            AuthMethod::Agent => {
                // Connect to SSH Agent and authenticate
                let mut agent = crate::ssh::agent::SshAgentClient::connect().await?;
                agent
                    .authenticate(&mut handle, self.config.username.clone())
                    .await?;
                client::AuthResult::Success
            }
            AuthMethod::Certificate {
                key_path,
                cert_path,
                passphrase,
            } => {
                let (key, cert) =
                    load_certificate_auth_material(key_path, cert_path, passphrase.as_deref())?;

                // Authenticate with certificate
                handle
                    .authenticate_openssh_cert(&self.config.username, key, cert)
                    .await
                    .map_err(|e| {
                        SshError::AuthenticationFailed(format!(
                            "Certificate authentication failed: {}",
                            e
                        ))
                    })?
            }
            AuthMethod::KeyboardInteractive => {
                // KeyboardInteractive is handled by the separate KBI flow (commands/kbi.rs)
                // This path should never be reached - KBI uses ssh_connect_kbi command
                return Err(SshError::AuthenticationFailed(
                    "KeyboardInteractive must be initiated via ssh_connect_kbi command".to_string(),
                ));
            }
        };

        ensure_auth_success(&authenticated, "Authentication rejected by server")?;

        info!("SSH authentication successful");

        // Create session
        Ok(SshSession::new(
            handle,
            self.config.cols,
            self.config.rows,
            self.config.agent_forwarding,
        ))
    }
}

/// Client handler for russh callbacks
///
/// This handler processes server-initiated events, including:
/// - Host key verification against ~/.ssh/known_hosts
/// - Remote port forwarding (forwarded-tcpip channels)
/// - SSH agent forwarding relay
pub struct ClientHandler {
    /// Target host for key verification
    host: String,
    /// Target port
    port: u16,
    /// Strict host key checking mode
    /// - true: reject unknown/changed keys
    /// - false: auto-accept unknown keys (still reject changed)
    strict: bool,
    /// Trust host key mode for TOFU
    /// - None: use strict behavior
    /// - Some(true): trust and save unknown keys
    /// - Some(false): trust for session only (don't save)
    trust_host_key: Option<bool>,
    /// Whether agent forwarding was requested by the client.
    /// Defense-in-depth: reject server-initiated agent channels if we never asked.
    agent_forwarding_requested: bool,
    /// Semaphore to limit concurrent agent forwarding channels (max 16)
    agent_forward_semaphore: std::sync::Arc<tokio::sync::Semaphore>,
}

impl ClientHandler {
    pub fn new(host: String, port: u16, strict: bool) -> Self {
        Self {
            host,
            port,
            strict,
            trust_host_key: None,
            agent_forwarding_requested: false,
            agent_forward_semaphore: std::sync::Arc::new(tokio::sync::Semaphore::new(16)),
        }
    }

    pub fn with_trust(
        host: String,
        port: u16,
        strict: bool,
        trust_host_key: Option<bool>,
        agent_forwarding: bool,
    ) -> Self {
        Self {
            host,
            port,
            strict,
            trust_host_key,
            agent_forwarding_requested: agent_forwarding,
            agent_forward_semaphore: std::sync::Arc::new(tokio::sync::Semaphore::new(16)),
        }
    }

    /// Mark that agent forwarding was requested on this connection.
    /// Must be called after sending `auth-agent-req@openssh.com`.
    pub fn set_agent_forwarding_requested(&mut self, requested: bool) {
        self.agent_forwarding_requested = requested;
    }
}

impl client::Handler for ClientHandler {
    type Error = SshError;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let known_hosts = get_known_hosts();
        let verification = known_hosts.verify(&self.host, self.port, server_public_key);

        match verification {
            HostKeyVerification::Verified => {
                info!("Host key verified for {}:{}", self.host, self.port);
                Ok(true)
            }
            HostKeyVerification::Unknown { fingerprint } => {
                // Check if user has pre-approved this key via TOFU flow
                if let Some(trust) = self.trust_host_key {
                    if trust {
                        // Trust and save to known_hosts
                        info!(
                            "TOFU: Trusting and saving host key for {}:{} (fingerprint: {})",
                            self.host, self.port, fingerprint
                        );
                        if let Err(e) =
                            known_hosts.add_host(&self.host, self.port, server_public_key)
                        {
                            warn!("Failed to save host key: {}", e);
                        }
                    } else {
                        // Trust for this session only (don't save)
                        info!(
                            "TOFU: Trusting host key for session only {}:{} (fingerprint: {})",
                            self.host, self.port, fingerprint
                        );
                    }
                    return Ok(true);
                }

                if self.strict {
                    // Strict mode: reject unknown hosts
                    warn!(
                        "Unknown host key for {}:{} (fingerprint: {}). Strict mode enabled, rejecting.",
                        self.host, self.port, fingerprint
                    );
                    Err(SshError::ConnectionFailed(format!(
                        "Host key verification failed: unknown host {}:{}. Fingerprint: {}. \
                         Add to known_hosts or disable strict mode.",
                        self.host, self.port, fingerprint
                    )))
                } else {
                    // Non-strict mode: auto-accept and save unknown keys
                    // NOTE: This is the legacy behavior, kept for backward compatibility
                    info!(
                        "New host {}:{}, auto-adding to known_hosts (fingerprint: {})",
                        self.host, self.port, fingerprint
                    );
                    if let Err(e) = known_hosts.add_host(&self.host, self.port, server_public_key) {
                        warn!("Failed to save host key: {}", e);
                    }
                    Ok(true)
                }
            }
            HostKeyVerification::Changed {
                expected_fingerprint,
                actual_fingerprint,
            } => {
                // ALWAYS reject changed keys - potential MITM attack
                warn!(
                    "HOST KEY CHANGED for {}:{}! Expected {}, got {}. POSSIBLE MITM ATTACK!",
                    self.host, self.port, expected_fingerprint, actual_fingerprint
                );
                Err(SshError::ConnectionFailed(format!(
                    "HOST KEY VERIFICATION FAILED: Key for {}:{} has changed! \
                     Expected: {}, Actual: {}. \
                     This could indicate a man-in-the-middle attack. \
                     If the key change is legitimate, remove the old key from ~/.ssh/known_hosts",
                    self.host, self.port, expected_fingerprint, actual_fingerprint
                )))
            }
        }
    }

    /// Called when the server opens a channel for a new remote port forwarding connection.
    /// This happens when someone connects to the forwarded port on the remote server.
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<client::Msg>,
        connected_address: &str,
        connected_port: u32,
        originator_address: &str,
        originator_port: u32,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        info!(
            "Server opened forwarded-tcpip channel: {}:{} from {}:{}",
            connected_address, connected_port, originator_address, originator_port
        );

        // Import the handler function from forwarding module
        use crate::forwarding::remote::handle_forwarded_connection;

        let connected_address = connected_address.to_string();
        let originator_address = originator_address.to_string();

        // Spawn a task to handle this forwarded connection
        // We can't block here as this is called from the SSH event loop
        tokio::spawn(async move {
            if let Err(e) = handle_forwarded_connection(
                channel,
                &connected_address,
                connected_port,
                &originator_address,
                originator_port,
            )
            .await
            {
                warn!(
                    "Failed to handle forwarded connection {}:{}: {}",
                    connected_address, connected_port, e
                );
            }
        });

        Ok(())
    }

    /// Called when the server opens an agent forwarding channel.
    /// This happens when the remote side needs to use the local SSH agent
    /// (e.g., for `ssh` commands on the remote host).
    ///
    /// Defense-in-depth: rejects the channel if agent forwarding was not requested,
    /// and limits concurrent agent channels via semaphore.
    async fn server_channel_open_agent_forward(
        &mut self,
        channel: Channel<client::Msg>,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        // Defense-in-depth: reject unsolicited agent channels
        if !self.agent_forwarding_requested {
            warn!(
                "Server {}:{} tried to open agent channel but forwarding was not requested — rejecting",
                self.host, self.port
            );
            let _ = channel.eof().await;
            return Ok(());
        }

        info!("Server opened agent forwarding channel");

        use super::agent_forward::handle_agent_forward_channel;

        // Acquire semaphore permit to limit concurrent agent channels
        let semaphore = self.agent_forward_semaphore.clone();
        let permit = match semaphore.try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                warn!("Too many concurrent agent forwarding channels — rejecting");
                let _ = channel.eof().await;
                return Ok(());
            }
        };

        // Spawn a task to handle this agent forwarding channel
        // We can't block here as this is called from the SSH event loop
        tokio::spawn(async move {
            handle_agent_forward_channel(channel).await;
            drop(permit); // Release semaphore when done
        });

        Ok(())
    }
}
