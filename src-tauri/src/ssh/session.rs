// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

//! SSH Session management

use russh::client::Handle;
use russh::{ChannelMsg, Pty};
use tokio::sync::{broadcast, mpsc};
use tracing::{debug, error, info, warn};

use super::client::ClientHandler;
use super::error::SshError;
use super::handle_owner::{HandleController, spawn_handle_owner_task};

/// Standard PTY modes matching OpenSSH client defaults.
/// Ensures the remote PTY is correctly configured for interactive use
/// with a modern terminal emulator (xterm-256color).
pub const DEFAULT_PTY_MODES: &[(Pty, u32)] = &[
    // Special characters
    (Pty::VINTR, 0x03),    // Ctrl+C
    (Pty::VQUIT, 0x1c),    // Ctrl+\
    (Pty::VERASE, 0x7f),   // DEL (backspace)
    (Pty::VKILL, 0x15),    // Ctrl+U
    (Pty::VEOF, 0x04),     // Ctrl+D
    (Pty::VEOL, 0x00),     // disabled
    (Pty::VEOL2, 0x00),    // disabled
    (Pty::VSTART, 0x11),   // Ctrl+Q (XON)
    (Pty::VSTOP, 0x13),    // Ctrl+S (XOFF)
    (Pty::VSUSP, 0x1a),    // Ctrl+Z
    (Pty::VREPRINT, 0x12), // Ctrl+R
    (Pty::VWERASE, 0x17),  // Ctrl+W
    (Pty::VLNEXT, 0x16),   // Ctrl+V
    (Pty::VDISCARD, 0x0f), // Ctrl+O
    // Input modes
    (Pty::ICRNL, 1),   // Map CR to NL on input
    (Pty::IXON, 1),    // Enable XON/XOFF flow control
    (Pty::IMAXBEL, 1), // Ring bell on input queue full
    (Pty::IUTF8, 1),   // UTF-8 input
    // Local modes
    (Pty::ISIG, 1),    // Enable signals
    (Pty::ICANON, 1),  // Canonical mode
    (Pty::ECHO, 1),    // Echo input
    (Pty::ECHOE, 1),   // Echo erase as backspace
    (Pty::ECHOK, 1),   // Echo kill
    (Pty::IEXTEN, 1),  // Extended input processing
    (Pty::ECHOCTL, 1), // Echo control chars as ^X
    (Pty::ECHOKE, 1),  // Echo kill with BS-SP-BS
    // Output modes
    (Pty::OPOST, 1), // Post-process output
    (Pty::ONLCR, 1), // Map NL to CR-NL on output
    // Character size
    (Pty::CS8, 1), // 8-bit characters
    // Speeds
    (Pty::TTY_OP_ISPEED, 38400),
    (Pty::TTY_OP_OSPEED, 38400),
];

/// Commands that can be sent to the SSH session
#[derive(Debug)]
pub enum SessionCommand {
    /// Data to send to SSH stdin
    Data(Vec<u8>),
    /// Resize the PTY (cols, rows)
    Resize(u16, u16),
    /// Close the session
    Close,
}

/// A handle to an active SSH session
pub struct SessionHandle {
    /// Unique session ID
    pub id: String,
    /// Channel for sending data to the SSH session (for backward compatibility)
    pub stdin_tx: mpsc::Sender<Vec<u8>>,
    /// Channel for receiving data from the SSH session
    pub stdout_rx: mpsc::Receiver<Vec<u8>>,
}

/// Extended session handle with command channel
pub struct ExtendedSessionHandle {
    /// Unique session ID
    pub id: String,
    /// Channel for sending commands to the SSH session
    pub cmd_tx: mpsc::Sender<SessionCommand>,
    /// Channel for receiving data from the SSH session
    pub stdout_rx: broadcast::Receiver<Vec<u8>>,
}

impl Drop for SessionHandle {
    fn drop(&mut self) {
        // Best-effort cleanup - ignore errors
        debug!("Dropping SessionHandle for session {}", self.id);
        // stdin_tx will be dropped automatically, closing the channel
    }
}

impl Drop for ExtendedSessionHandle {
    fn drop(&mut self) {
        // Send Close command to ensure SSH process cleanup
        debug!("Dropping ExtendedSessionHandle for session {}", self.id);
        let _ = self.cmd_tx.try_send(SessionCommand::Close);
        // If send fails, the session is already dead - that's fine
    }
}

// Allow taking ownership of handle contents despite Drop implementation
impl SessionHandle {
    /// Consumes the handle and returns its parts
    #[must_use = "into_parts transfers ownership - ignoring the result will leak resources"]
    pub fn into_parts(self) -> (String, mpsc::Sender<Vec<u8>>, mpsc::Receiver<Vec<u8>>) {
        // Use ManuallyDrop to prevent Drop from running
        let handle = std::mem::ManuallyDrop::new(self);
        // Safety: We're taking ownership and preventing double-drop via ManuallyDrop
        unsafe {
            let id = std::ptr::read(&handle.id);
            let stdin_tx = std::ptr::read(&handle.stdin_tx);
            let stdout_rx = std::ptr::read(&handle.stdout_rx);
            (id, stdin_tx, stdout_rx)
        }
    }
}

impl ExtendedSessionHandle {
    /// Consumes the handle and returns its parts
    #[must_use = "into_parts transfers ownership - ignoring the result will leak resources"]
    pub fn into_parts(
        self,
    ) -> (
        String,
        mpsc::Sender<SessionCommand>,
        broadcast::Receiver<Vec<u8>>,
    ) {
        // Use ManuallyDrop to prevent Drop from running
        let handle = std::mem::ManuallyDrop::new(self);
        // Safety: We're taking ownership and preventing double-drop via ManuallyDrop
        unsafe {
            let id = std::ptr::read(&handle.id);
            let cmd_tx = std::ptr::read(&handle.cmd_tx);
            let stdout_rx = std::ptr::read(&handle.stdout_rx);
            (id, cmd_tx, stdout_rx)
        }
    }
}

/// SSH Session with PTY
///
/// This struct holds the Handle temporarily before spawning the Handle Owner Task.
/// After calling `start()`, the Handle is moved into the owner task and a
/// `HandleController` is returned for further operations.
pub struct SshSession {
    handle: Handle<ClientHandler>,
    cols: u32,
    rows: u32,
    agent_forwarding: bool,
}

impl SshSession {
    pub fn new(
        handle: Handle<ClientHandler>,
        cols: u32,
        rows: u32,
        agent_forwarding: bool,
    ) -> Self {
        Self {
            handle,
            cols,
            rows,
            agent_forwarding,
        }
    }

    /// Start the Handle Owner Task and return a controller
    ///
    /// This consumes the Handle and spawns the owner task.
    /// The returned `HandleController` can be used to open channels, etc.
    pub fn start(self, session_id: String) -> HandleController {
        spawn_handle_owner_task(self.handle, session_id)
    }

    /// Get terminal dimensions
    pub fn dimensions(&self) -> (u32, u32) {
        (self.cols, self.rows)
    }

    /// Request a PTY and start an interactive shell session
    ///
    /// This is a convenience method that:
    /// 1. Spawns the Handle Owner Task
    /// 2. Opens a session channel via the controller
    /// 3. Requests PTY and shell
    /// 4. Spawns a shell handler task
    ///
    /// Returns both the `ExtendedSessionHandle` (for shell I/O) and
    /// the `HandleController` (for other operations like SFTP, forwarding)
    pub async fn request_shell_extended(
        self,
    ) -> Result<(ExtendedSessionHandle, HandleController), SshError> {
        let session_id = uuid::Uuid::new_v4().to_string();

        info!("Starting Handle Owner Task for session {}", session_id);

        // Spawn the Handle Owner Task - this takes ownership of the Handle
        let controller = spawn_handle_owner_task(self.handle, session_id.clone());

        info!("Opening extended channel for session {}", session_id);

        // Open a session channel via the controller
        let mut channel = controller.open_session_channel().await?;

        debug!("Channel opened, requesting PTY");

        // Request PTY
        channel
            .request_pty(
                false,
                "xterm-256color",
                self.cols,
                self.rows,
                0,
                0,
                DEFAULT_PTY_MODES,
            )
            .await
            .map_err(|e| SshError::ChannelError(format!("PTY request failed: {}", e)))?;

        debug!("PTY allocated, requesting shell");

        // Request agent forwarding if enabled (must be before shell)
        if self.agent_forwarding {
            debug!("Requesting SSH agent forwarding");
            if let Err(e) = channel.agent_forward(false).await {
                warn!("Agent forwarding request failed (non-fatal): {}", e);
            }
        }

        // Request shell
        channel
            .request_shell(false)
            .await
            .map_err(|e| SshError::ChannelError(format!("Shell request failed: {}", e)))?;

        info!(
            "Interactive shell (extended) started for session {}",
            session_id
        );

        // Create channels for communication
        let (cmd_tx, mut cmd_rx) = mpsc::channel::<SessionCommand>(1024);
        let (stdout_tx, stdout_rx) = broadcast::channel::<Vec<u8>>(1024);

        // Spawn task to handle the SSH channel with extended commands
        let sid = session_id.clone();
        tokio::spawn(async move {
            debug!("Extended channel handler started for session {}", sid);

            loop {
                tokio::select! {
                    // Handle commands
                    Some(cmd) = cmd_rx.recv() => {
                        match cmd {
                            SessionCommand::Data(data) => {
                                if let Err(e) = channel.data(&data[..]).await {
                                    error!("Failed to send data to SSH channel: {}", e);
                                    break;
                                }
                            }
                            SessionCommand::Resize(cols, rows) => {
                                debug!("Sending window_change: {}x{} for session {}", cols, rows, sid);
                                if let Err(e) = channel.window_change(cols as u32, rows as u32, 0, 0).await {
                                    error!("Failed to resize PTY: {}", e);
                                    // Don't break on resize error, continue
                                } else {
                                    info!("PTY resized to {}x{} for session {}", cols, rows, sid);
                                }
                            }
                            SessionCommand::Close => {
                                info!("Close command received for session {}", sid);
                                let _ = channel.eof().await;
                                break;
                            }
                        }
                    }

                    // Handle messages from SSH channel
                    Some(msg) = channel.wait() => {
                        match msg {
                            ChannelMsg::Data { data } => {
                                let _ = stdout_tx.send(data.to_vec());
                            }
                            ChannelMsg::ExtendedData { data, ext } => {
                                // Extended data (usually stderr)
                                if ext == 1 {
                                    let _ = stdout_tx.send(data.to_vec());
                                }
                            }
                            ChannelMsg::Eof => {
                                info!("SSH channel EOF for session {}", sid);
                                break;
                            }
                            ChannelMsg::Close => {
                                info!("SSH channel closed for session {}", sid);
                                break;
                            }
                            ChannelMsg::ExitStatus { exit_status } => {
                                info!("SSH channel exit status {} for session {}", exit_status, sid);
                            }
                            ChannelMsg::ExitSignal { signal_name, .. } => {
                                info!("SSH channel exit signal {:?} for session {}", signal_name, sid);
                            }
                            ChannelMsg::WindowAdjusted { .. } => {
                                // Window size adjusted, ignore
                            }
                            _ => {
                                debug!("Unhandled channel message");
                            }
                        }
                    }

                    else => {
                        debug!("Extended channel handler loop ended for session {}", sid);
                        break;
                    }
                }
            }

            info!("Extended channel handler terminated for session {}", sid);
        });

        Ok((
            ExtendedSessionHandle {
                id: session_id,
                cmd_tx,
                stdout_rx,
            },
            controller,
        ))
    }
}
