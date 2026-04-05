// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

//! SSH Agent Forwarding — relay between server-opened agent channels and the local SSH agent
//!
//! When agent forwarding is enabled and the remote side needs to authenticate via the agent,
//! the server opens an `auth-agent@openssh.com` channel back to the client. This module
//! handles those channels by connecting to the local SSH agent socket and relaying data
//! bidirectionally using `tokio::io::copy_bidirectional`.
//!
//! # Security
//!
//! Agent forwarding allows the remote server to use local SSH keys for authentication.
//! Only enable this for trusted servers — a malicious server could use the agent to
//! authenticate to other hosts the user has access to.

use russh::Channel;
use russh::client;
use tracing::{debug, info, warn};

/// Handle a server-initiated agent forwarding channel.
///
/// This function connects to the local SSH agent and relays data between
/// the SSH channel and the agent socket using `tokio::io::copy_bidirectional`.
pub async fn handle_agent_forward_channel(channel: Channel<client::Msg>) {
    info!("Handling agent forwarding channel");

    // Connect to the local SSH agent
    let agent_stream = match connect_agent_stream().await {
        Ok(stream) => stream,
        Err(e) => {
            warn!("Failed to connect to local SSH agent for forwarding: {}", e);
            let _ = channel.eof().await;
            return;
        }
    };

    // Relay data bidirectionally between the SSH channel and the local agent
    relay(channel, agent_stream).await;
}

/// Relay data between the SSH channel and the local agent stream.
async fn relay(
    channel: Channel<client::Msg>,
    mut agent_stream: impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
) {
    let mut channel_stream = channel.into_stream();
    debug!("Starting agent forwarding relay");

    match tokio::io::copy_bidirectional(&mut channel_stream, &mut agent_stream).await {
        Ok((to_agent, from_agent)) => {
            info!(
                "Agent forwarding relay completed: {} bytes to agent, {} bytes from agent",
                to_agent, from_agent
            );
        }
        Err(e) => {
            debug!("Agent forwarding relay ended: {}", e);
        }
    }
}

/// Connect to the local SSH agent and return an async stream.
///
/// - **Unix/macOS**: Connects via the `SSH_AUTH_SOCK` Unix domain socket.
/// - **Windows**: Connects to the OpenSSH named pipe `\\.\pipe\openssh-ssh-agent`.
#[cfg(unix)]
async fn connect_agent_stream() -> Result<tokio::net::UnixStream, String> {
    let sock_path = std::env::var("SSH_AUTH_SOCK")
        .map_err(|_| "SSH_AUTH_SOCK not set. Make sure ssh-agent is running.".to_string())?;

    debug!("Connecting to SSH agent at {}", sock_path);

    tokio::net::UnixStream::connect(&sock_path)
        .await
        .map_err(|e| format!("Failed to connect to SSH agent socket {}: {}", sock_path, e))
}

#[cfg(windows)]
async fn connect_agent_stream() -> Result<tokio::net::windows::named_pipe::NamedPipeClient, String>
{
    use tokio::net::windows::named_pipe::ClientOptions;

    let pipe_name = r"\\.\pipe\openssh-ssh-agent";
    debug!("Connecting to SSH agent at {}", pipe_name);

    ClientOptions::new().open(pipe_name).map_err(|e| {
        format!(
            "Failed to connect to SSH agent named pipe {}: {}. \
                 Make sure the OpenSSH Authentication Agent service is running.",
            pipe_name, e
        )
    })
}

#[cfg(not(any(unix, windows)))]
async fn connect_agent_stream() -> Result<(), String> {
    Err("SSH agent forwarding is not supported on this platform".to_string())
}
