// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

//! Local Terminal Registry
//!
//! Manages multiple local terminal sessions with thread-safe access.
//! Provides session lifecycle management, event routing, and
//! background (detach/reattach) support.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{RwLock, mpsc, oneshot};

use crate::local::session::{
    BackgroundSessionInfo, LocalTerminalInfo, LocalTerminalSession, SessionError, SessionEvent,
};
use crate::local::shell::ShellInfo;
use crate::session::{BufferStats, ScrollBuffer, TerminalLine};
use crate::ssh::{ExtendedSessionHandle, SessionCommand};

/// Maximum number of background (detached) sessions allowed
const MAX_BACKGROUND_SESSIONS: usize = 5;

/// Idle TTL for background sessions (30 minutes)
const IDLE_DETACH_TTL: Duration = Duration::from_secs(30 * 60);

/// Active TTL for background sessions with running children (4 hours)
const ACTIVE_DETACH_TTL: Duration = Duration::from_secs(4 * 60 * 60);

/// Registry for managing multiple local terminal sessions
pub struct LocalTerminalRegistry {
    sessions: Arc<RwLock<HashMap<String, LocalTerminalSession>>>,
    /// Channel senders for each session's events (session_id -> sender)
    event_channels: Arc<RwLock<HashMap<String, mpsc::Sender<SessionEvent>>>>,
}

impl LocalTerminalRegistry {
    /// Create a new registry
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            event_channels: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Create a new local terminal session
    pub async fn create_session(
        &self,
        shell: ShellInfo,
        cols: u16,
        rows: u16,
        cwd: Option<std::path::PathBuf>,
    ) -> Result<(String, mpsc::Receiver<SessionEvent>), SessionError> {
        // Use defaults: load profile, no OMP
        self.create_session_with_options(shell, cols, rows, cwd, true, false, None)
            .await
    }

    /// Create a new local terminal session with extended options
    pub async fn create_session_with_options(
        &self,
        shell: ShellInfo,
        cols: u16,
        rows: u16,
        cwd: Option<std::path::PathBuf>,
        load_profile: bool,
        oh_my_posh_enabled: bool,
        oh_my_posh_theme: Option<String>,
    ) -> Result<(String, mpsc::Receiver<SessionEvent>), SessionError> {
        let mut session = LocalTerminalSession::new(shell, cols, rows);
        let session_id = session.id.clone();

        // Create event channel for this session
        let (event_tx, event_rx) = mpsc::channel::<SessionEvent>(256);

        // Store event sender
        {
            let mut channels = self.event_channels.write().await;
            channels.insert(session_id.clone(), event_tx.clone());
        }

        // Start the session with options
        session
            .start_with_options(
                cwd,
                event_tx,
                load_profile,
                oh_my_posh_enabled,
                oh_my_posh_theme,
            )
            .await?;

        // Store session
        {
            let mut sessions = self.sessions.write().await;
            sessions.insert(session_id.clone(), session);
        }

        tracing::info!(
            "Created local terminal session: {}, total sessions: {}",
            session_id,
            self.sessions.read().await.len()
        );

        Ok((session_id, event_rx))
    }

    /// Create a new Telnet-backed terminal session.
    pub async fn create_telnet_session(
        &self,
        host: String,
        port: u16,
        cols: u16,
        rows: u16,
    ) -> Result<(String, mpsc::Receiver<SessionEvent>), SessionError> {
        let mut session = LocalTerminalSession::new_telnet(host.clone(), port, cols, rows);
        let session_id = session.id.clone();
        let (event_tx, event_rx) = mpsc::channel::<SessionEvent>(256);

        {
            let mut channels = self.event_channels.write().await;
            channels.insert(session_id.clone(), event_tx.clone());
        }

        session.start_telnet(host, port, event_tx).await?;

        {
            let mut sessions = self.sessions.write().await;
            sessions.insert(session_id.clone(), session);
        }

        tracing::info!(
            "Created Telnet terminal session: {}, total sessions: {}",
            session_id,
            self.sessions.read().await.len()
        );

        Ok((session_id, event_rx))
    }

    /// Get session info
    pub async fn get_session_info(&self, session_id: &str) -> Option<LocalTerminalInfo> {
        let sessions = self.sessions.read().await;
        sessions.get(session_id).map(|s| s.info())
    }

    /// List all sessions
    pub async fn list_sessions(&self) -> Vec<LocalTerminalInfo> {
        let sessions = self.sessions.read().await;
        let mut items: Vec<_> = sessions.values().map(|s| s.info()).collect();
        items.sort_by(|left, right| left.created_at.cmp(&right.created_at));
        items
    }

    /// Write data to a session
    pub async fn write_to_session(
        &self,
        session_id: &str,
        data: &[u8],
    ) -> Result<(), SessionError> {
        let sessions = self.sessions.read().await;
        match sessions.get(session_id) {
            Some(session) => session.write(data).await,
            None => Err(SessionError::NotFound(session_id.to_string())),
        }
    }

    pub async fn get_scroll_buffer(
        &self,
        session_id: &str,
        start_line: usize,
        count: usize,
    ) -> Result<Vec<TerminalLine>, SessionError> {
        let scroll_buffer = {
            let sessions = self.sessions.read().await;
            sessions
                .get(session_id)
                .map(|session| session.scroll_buffer.clone())
                .ok_or_else(|| SessionError::NotFound(session_id.to_string()))?
        };

        Ok(scroll_buffer.get_range(start_line, count).await)
    }

    pub async fn get_buffer_stats(&self, session_id: &str) -> Result<BufferStats, SessionError> {
        let scroll_buffer = {
            let sessions = self.sessions.read().await;
            sessions
                .get(session_id)
                .map(|session| session.scroll_buffer.clone())
                .ok_or_else(|| SessionError::NotFound(session_id.to_string()))?
        };

        Ok(scroll_buffer.stats().await)
    }

    pub async fn get_capped_buffer(
        &self,
        session_id: &str,
        cap: usize,
    ) -> Result<(Vec<TerminalLine>, usize), SessionError> {
        let scroll_buffer = {
            let sessions = self.sessions.read().await;
            sessions
                .get(session_id)
                .map(|session| session.scroll_buffer.clone())
                .ok_or_else(|| SessionError::NotFound(session_id.to_string()))?
        };

        Ok(scroll_buffer.get_capped(cap).await)
    }

    /// Resize a session
    pub async fn resize_session(
        &self,
        session_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), SessionError> {
        let mut sessions = self.sessions.write().await;
        match sessions.get_mut(session_id) {
            Some(session) => session.resize(cols, rows),
            None => Err(SessionError::NotFound(session_id.to_string())),
        }
    }

    /// Close a session
    pub async fn close_session(&self, session_id: &str) -> Result<(), SessionError> {
        // Remove and close session
        let mut sessions = self.sessions.write().await;
        match sessions.remove(session_id) {
            Some(mut session) => {
                session.close();
                tracing::info!(
                    "Closed local terminal session: {}, remaining: {}",
                    session_id,
                    sessions.len()
                );
            }
            None => {
                return Err(SessionError::NotFound(session_id.to_string()));
            }
        }

        // Remove event channel
        {
            let mut channels = self.event_channels.write().await;
            channels.remove(session_id);
        }

        Ok(())
    }

    /// Detach a session (send to background).
    /// PTY stays alive; output continues to be buffered in ScrollBuffer.
    /// A TTL timer starts — idle sessions expire after 30 min, active after 4 h.
    pub async fn detach_session(
        &self,
        session_id: &str,
    ) -> Result<BackgroundSessionInfo, SessionError> {
        let sessions = self.sessions.read().await;

        // Check background limit
        let bg_count = sessions.values().filter(|s| s.is_detached()).count();
        if bg_count >= MAX_BACKGROUND_SESSIONS {
            return Err(SessionError::BackgroundLimitReached(
                MAX_BACKGROUND_SESSIONS,
            ));
        }

        let session = sessions
            .get(session_id)
            .ok_or_else(|| SessionError::NotFound(session_id.to_string()))?;

        if session.is_detached() {
            return Err(SessionError::AlreadyDetached);
        }

        if !session.is_running() {
            return Err(SessionError::AlreadyClosed);
        }

        session.detach();

        // Choose TTL based on whether the session has active child processes
        let ttl = if session.has_child_processes() {
            ACTIVE_DETACH_TTL
        } else {
            IDLE_DETACH_TTL
        };

        // Start TTL timer with cancel channel
        let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
        if let Ok(mut cancel) = session.detach_cancel.lock() {
            *cancel = Some(cancel_tx);
        }

        let buffer_lines = session.scroll_buffer.len().await;
        let info = BackgroundSessionInfo {
            id: session.id.clone(),
            shell: session.shell.clone(),
            cols: session.cols,
            rows: session.rows,
            running: session.is_running(),
            detached_secs: 0,
            buffer_lines,
        };

        // Spawn TTL timer task
        let sid = session_id.to_string();
        let sessions_ref = self.sessions.clone();
        let channels_ref = self.event_channels.clone();
        tokio::spawn(async move {
            tokio::select! {
                _ = tokio::time::sleep(ttl) => {
                    tracing::info!("Background session {} TTL expired ({:?}), cleaning up", sid, ttl);
                    let mut sessions = sessions_ref.write().await;
                    if let Some(mut session) = sessions.remove(&sid) {
                        session.close();
                    }
                    let mut channels = channels_ref.write().await;
                    channels.remove(&sid);
                }
                _ = cancel_rx => {
                    tracing::debug!("Background TTL timer cancelled for session {}", sid);
                }
            }
        });

        Ok(info)
    }

    /// Attach (reattach) a background session.
    /// Returns replay data (last N lines from ScrollBuffer) as raw bytes
    /// and a new event receiver for future data.
    pub async fn attach_session(
        &self,
        session_id: &str,
    ) -> Result<(Vec<u8>, mpsc::Receiver<SessionEvent>), SessionError> {
        let sessions = self.sessions.read().await;

        let session = sessions
            .get(session_id)
            .ok_or_else(|| SessionError::NotFound(session_id.to_string()))?;

        if !session.is_detached() {
            return Err(SessionError::NotDetached);
        }

        if !session.is_running() {
            return Err(SessionError::AlreadyClosed);
        }

        // Get replay data before marking as attached
        let replay = session.get_replay_data().await;

        // Mark as foreground
        session.attach();

        // Create new event channel for this session
        let (event_tx, event_rx) = mpsc::channel::<SessionEvent>(256);

        // Store the new event sender
        {
            let mut channels = self.event_channels.write().await;
            channels.insert(session_id.to_string(), event_tx.clone());
        }

        // Subscribe to the broadcast channel and forward to the new event channel
        let mut output_rx = session.output_tx.subscribe();
        let sid = session_id.to_string();
        tokio::spawn(async move {
            while let Ok(data) = output_rx.recv().await {
                if event_tx.send(SessionEvent::Data(data)).await.is_err() {
                    tracing::debug!("Event forwarder for reattached session {} stopped", sid);
                    break;
                }
            }
        });

        Ok((replay, event_rx))
    }

    /// List all background (detached) sessions
    pub async fn list_background_sessions(&self) -> Vec<BackgroundSessionInfo> {
        let sessions = self.sessions.read().await;
        let mut result = Vec::new();

        for session in sessions.values() {
            if session.is_detached() {
                let detached_secs = session
                    .detached_at
                    .lock()
                    .ok()
                    .and_then(|ts| ts.map(|t| t.elapsed().as_secs()))
                    .unwrap_or(0);

                let buffer_lines = session.scroll_buffer.len().await;

                result.push(BackgroundSessionInfo {
                    id: session.id.clone(),
                    shell: session.shell.clone(),
                    cols: session.cols,
                    rows: session.rows,
                    running: session.is_running(),
                    detached_secs,
                    buffer_lines,
                });
            }
        }

        result
    }

    /// Get the count of background sessions
    pub async fn background_count(&self) -> usize {
        let sessions = self.sessions.read().await;
        sessions.values().filter(|s| s.is_detached()).count()
    }

    /// Check if a session has active child processes
    pub async fn check_child_processes(&self, session_id: &str) -> Result<bool, SessionError> {
        let sessions = self.sessions.read().await;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| SessionError::NotFound(session_id.to_string()))?;
        Ok(session.has_child_processes())
    }

    /// Attach a CLI client to a running local terminal session.
    ///
    /// Unlike `attach_session()`, this does NOT modify the session's detached state.
    /// The GUI continues running normally while the CLI mirrors the session.
    /// Returns an `ExtendedSessionHandle` and scroll buffer for use with `WsBridge`.
    pub async fn attach_for_cli(
        &self,
        session_id: &str,
        readonly: bool,
    ) -> Result<(ExtendedSessionHandle, Arc<ScrollBuffer>, u16, u16), SessionError> {
        let sessions = self.sessions.read().await;

        let session = sessions
            .get(session_id)
            .ok_or_else(|| SessionError::NotFound(session_id.to_string()))?;

        if !session.is_running() {
            return Err(SessionError::AlreadyClosed);
        }

        let cols = session.cols;
        let rows = session.rows;
        let scroll_buffer = session.scroll_buffer.clone();

        // Clone the input channel and output broadcast sender
        let input_tx = session
            .input_tx
            .as_ref()
            .ok_or(SessionError::ChannelError)?
            .clone();
        let stdout_rx = session.output_tx.subscribe();

        // Create a SessionCommand adapter channel.
        // The CLI bridge sends SessionCommand values; we forward them
        // to the local terminal's input_tx and pty resize.
        let (cmd_tx, mut cmd_rx) = mpsc::channel::<SessionCommand>(1024);

        let sid = session_id.to_string();
        tokio::spawn(async move {
            while let Some(cmd) = cmd_rx.recv().await {
                match cmd {
                    SessionCommand::Data(data) => {
                        if readonly {
                            tracing::debug!(
                                "CLI attach adapter: readonly input ignored for {}",
                                sid
                            );
                            continue;
                        }
                        if input_tx.send(data).await.is_err() {
                            tracing::debug!("CLI adapter: input channel closed for {}", sid);
                            break;
                        }
                    }
                    SessionCommand::Resize(_c, _r) => {
                        tracing::debug!(
                            "CLI attach adapter: resize ignored for mirror local {}",
                            sid
                        );
                    }
                    SessionCommand::Close => {
                        tracing::debug!("CLI adapter: close command for {} (ignored)", sid);
                        break;
                    }
                }
            }
            tracing::debug!("CLI attach adapter stopped for session {}", sid);
        });

        let handle = ExtendedSessionHandle {
            id: session_id.to_string(),
            cmd_tx,
            stdout_rx,
        };

        Ok((handle, scroll_buffer, cols, rows))
    }

    /// Close all sessions
    pub async fn close_all(&self) {
        let mut sessions = self.sessions.write().await;
        for (id, mut session) in sessions.drain() {
            tracing::info!("Closing local terminal session: {}", id);
            session.close();
        }

        let mut channels = self.event_channels.write().await;
        channels.clear();
    }

    /// Get the number of active sessions
    pub async fn session_count(&self) -> usize {
        self.sessions.read().await.len()
    }

    /// Check if a session exists and is running
    pub async fn is_session_running(&self, session_id: &str) -> bool {
        let sessions = self.sessions.read().await;
        sessions
            .get(session_id)
            .map(|s| s.is_running())
            .unwrap_or(false)
    }

    /// Clean up dead sessions (sessions that have stopped running)
    pub async fn cleanup_dead_sessions(&self) -> Vec<String> {
        let mut sessions = self.sessions.write().await;
        let mut channels = self.event_channels.write().await;

        let dead_ids: Vec<String> = sessions
            .iter()
            .filter(|(_, session)| !session.is_running())
            .map(|(id, _)| id.clone())
            .collect();

        for id in &dead_ids {
            if let Some(mut session) = sessions.remove(id) {
                session.close();
            }
            channels.remove(id);
            tracing::info!("Cleaned up dead session: {}", id);
        }

        dead_ids
    }
}

impl Default for LocalTerminalRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for LocalTerminalRegistry {
    fn drop(&mut self) {
        // Note: async cleanup cannot happen in Drop
        // Sessions should be closed explicitly before dropping
        tracing::debug!("LocalTerminalRegistry dropped");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::{Duration, timeout};

    fn test_shell() -> ShellInfo {
        ShellInfo::new("zsh", "Zsh", "/bin/zsh")
    }

    fn test_session(id: &str, created_at: chrono::DateTime<chrono::Utc>) -> LocalTerminalSession {
        let mut session = LocalTerminalSession::new(test_shell(), 80, 24);
        session.id = id.to_string();
        session.created_at = created_at;
        session
    }

    #[tokio::test]
    async fn test_registry_new() {
        let registry = LocalTerminalRegistry::new();
        assert_eq!(registry.session_count().await, 0);
        assert!(registry.list_sessions().await.is_empty());
    }

    #[tokio::test]
    async fn list_sessions_returns_created_at_order() {
        let registry = LocalTerminalRegistry::new();
        let older = test_session(
            "local-older",
            chrono::DateTime::parse_from_rfc3339("2026-04-19T12:00:00Z")
                .unwrap()
                .with_timezone(&chrono::Utc),
        );
        let newer = test_session(
            "local-newer",
            chrono::DateTime::parse_from_rfc3339("2026-04-19T12:00:01Z")
                .unwrap()
                .with_timezone(&chrono::Utc),
        );

        {
            let mut sessions = registry.sessions.write().await;
            sessions.insert(newer.id.clone(), newer);
            sessions.insert(older.id.clone(), older);
        }

        let listed = registry.list_sessions().await;
        let ids: Vec<_> = listed.iter().map(|item| item.id.as_str()).collect();

        assert_eq!(ids, vec!["local-older", "local-newer"]);
    }

    #[tokio::test]
    async fn attach_for_cli_readonly_drops_input_data() {
        let registry = LocalTerminalRegistry::new();
        let mut session = test_session(
            "local-readonly",
            chrono::DateTime::parse_from_rfc3339("2026-04-19T12:00:00Z")
                .unwrap()
                .with_timezone(&chrono::Utc),
        );
        let (input_tx, mut input_rx) = mpsc::channel::<Vec<u8>>(8);
        session.install_test_input_channel(input_tx);

        {
            let mut sessions = registry.sessions.write().await;
            sessions.insert(session.id.clone(), session);
        }

        let (handle, _, _, _) = registry
            .attach_for_cli("local-readonly", true)
            .await
            .unwrap();
        handle
            .cmd_tx
            .send(SessionCommand::Data(b"hello".to_vec()))
            .await
            .unwrap();

        assert!(
            timeout(Duration::from_millis(100), input_rx.recv())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn attach_for_cli_writable_forwards_input_data() {
        let registry = LocalTerminalRegistry::new();
        let mut session = test_session(
            "local-write",
            chrono::DateTime::parse_from_rfc3339("2026-04-19T12:00:00Z")
                .unwrap()
                .with_timezone(&chrono::Utc),
        );
        let (input_tx, mut input_rx) = mpsc::channel::<Vec<u8>>(8);
        session.install_test_input_channel(input_tx);

        {
            let mut sessions = registry.sessions.write().await;
            sessions.insert(session.id.clone(), session);
        }

        let (handle, _, _, _) = registry.attach_for_cli("local-write", false).await.unwrap();
        handle
            .cmd_tx
            .send(SessionCommand::Data(b"hello".to_vec()))
            .await
            .unwrap();

        assert_eq!(
            timeout(Duration::from_millis(100), input_rx.recv())
                .await
                .unwrap()
                .unwrap(),
            b"hello".to_vec()
        );
    }
}
