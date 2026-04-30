// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

//! Authoritative command facts for terminal runtime metadata.
//!
//! This store is intentionally independent from frontend xterm decorations.
//! Phase 1 uses it as a shadow-written fact model while the existing frontend
//! command marks continue to own presentation and hit-testing.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::sync::RwLock;
use uuid::Uuid;

use super::scroll_buffer::BufferLineIdentity;

const MAX_COMMAND_TEXT_LENGTH: usize = 16_384;
const MAX_CWD_LENGTH: usize = 4_096;
const MAX_SOURCE_LENGTH: usize = 128;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CommandFactSource {
    CommandBar,
    Ai,
    Broadcast,
    UserInputObserved,
    Heuristic,
    ShellIntegration,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CommandFactClosedBy {
    NextCommand,
    ShellIntegration,
    TerminalReset,
    SessionLost,
    InterruptedMode,
    Timeout,
    Manual,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CommandFactConfidence {
    High,
    Medium,
    Low,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CommandFactStatus {
    Open,
    Closed,
    Stale,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandFact {
    pub fact_id: String,
    pub client_mark_id: Option<String>,
    pub correlation_id: Option<String>,
    pub session_id: String,
    pub node_id: Option<String>,
    pub source: CommandFactSource,
    pub submitted_by: Option<CommandFactSource>,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub start_global_line: u64,
    pub command_global_line: u64,
    pub output_start_global_line: Option<u64>,
    pub end_global_line: Option<u64>,
    pub buffer_generation: u64,
    pub runtime_epoch: String,
    pub status: CommandFactStatus,
    pub confidence: CommandFactConfidence,
    pub closed_by: Option<CommandFactClosedBy>,
    pub exit_code: Option<i32>,
    pub created_at: u64,
    pub closed_at: Option<u64>,
    pub stale_reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCommandFactRequest {
    pub client_mark_id: Option<String>,
    pub correlation_id: Option<String>,
    pub node_id: Option<String>,
    pub source: CommandFactSource,
    pub submitted_by: Option<CommandFactSource>,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub start_global_line: u64,
    pub command_global_line: u64,
    pub output_start_global_line: Option<u64>,
    pub runtime_epoch: Option<String>,
    pub confidence: Option<CommandFactConfidence>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCommandFactResponse {
    pub fact_id: String,
    pub fact: CommandFact,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseCommandFactPatch {
    pub end_global_line: Option<u64>,
    pub closed_by: Option<CommandFactClosedBy>,
    pub exit_code: Option<i32>,
    pub status: Option<CommandFactStatus>,
    pub stale_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandFactOutputResponse {
    pub text: String,
    pub truncated: bool,
    pub line_count: usize,
    pub stale: bool,
}

#[derive(Default)]
struct CommandFactStoreInner {
    facts: Vec<CommandFact>,
    client_index: HashMap<String, String>,
}

#[derive(Default)]
pub struct CommandFactStore {
    inner: RwLock<CommandFactStoreInner>,
}

impl CommandFactStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn create_fact(
        &self,
        session_id: &str,
        request: CreateCommandFactRequest,
        identity: BufferLineIdentity,
    ) -> CommandFact {
        let now = now_millis();
        let fact_id = Uuid::new_v4().to_string();
        let command = request
            .command
            .as_deref()
            .map(sanitize_optional_text)
            .filter(|value| !value.is_empty());
        let cwd = request
            .cwd
            .as_deref()
            .map(|value| sanitize_text(value, MAX_CWD_LENGTH))
            .filter(|value| !value.is_empty());
        let runtime_epoch = request
            .runtime_epoch
            .as_deref()
            .map(|value| sanitize_text(value, MAX_SOURCE_LENGTH))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "default".to_string());
        let start_global_line = request.start_global_line.max(identity.base_global_line);
        let command_global_line = request.command_global_line.max(start_global_line);
        let output_start_global_line = request
            .output_start_global_line
            .map(|line| line.max(command_global_line));

        let fact = CommandFact {
            fact_id: fact_id.clone(),
            client_mark_id: request.client_mark_id.clone(),
            correlation_id: request.correlation_id,
            session_id: session_id.to_string(),
            node_id: request.node_id,
            source: request.source,
            submitted_by: request.submitted_by,
            command,
            cwd,
            start_global_line,
            command_global_line,
            output_start_global_line,
            end_global_line: None,
            buffer_generation: identity.buffer_generation,
            runtime_epoch,
            status: CommandFactStatus::Open,
            confidence: request.confidence.unwrap_or(CommandFactConfidence::High),
            closed_by: None,
            exit_code: None,
            created_at: now,
            closed_at: None,
            stale_reason: None,
        };

        let mut inner = self.inner.write().await;
        conservatively_close_previous_open_fact(&mut inner.facts, &fact, now);
        if let Some(client_mark_id) = &fact.client_mark_id {
            inner
                .client_index
                .insert(client_mark_id.clone(), fact_id.clone());
        }
        inner.facts.push(fact.clone());
        fact
    }

    pub async fn close_fact(
        &self,
        fact_id: &str,
        patch: CloseCommandFactPatch,
    ) -> Option<CommandFact> {
        let mut inner = self.inner.write().await;
        let fact = inner
            .facts
            .iter_mut()
            .find(|candidate| candidate.fact_id == fact_id)?;
        apply_close_patch(fact, patch, now_millis());
        Some(fact.clone())
    }

    pub async fn get_fact(&self, fact_id: &str) -> Option<CommandFact> {
        let inner = self.inner.read().await;
        inner
            .facts
            .iter()
            .find(|candidate| candidate.fact_id == fact_id)
            .cloned()
    }

    pub async fn query_facts(&self, global_start: u64, global_end: u64) -> Vec<CommandFact> {
        let (start, end) = if global_start <= global_end {
            (global_start, global_end)
        } else {
            (global_end, global_start)
        };
        let inner = self.inner.read().await;
        inner
            .facts
            .iter()
            .filter(|fact| {
                let fact_end = fact.end_global_line.unwrap_or(fact.start_global_line);
                fact.start_global_line <= end && fact_end >= start
            })
            .cloned()
            .collect()
    }

    pub async fn mark_open_facts_stale(
        &self,
        reason: &str,
        closed_by: CommandFactClosedBy,
    ) -> Vec<CommandFact> {
        let now = now_millis();
        let stale_reason = sanitize_text(reason, MAX_SOURCE_LENGTH);
        let mut inner = self.inner.write().await;
        let mut changed = Vec::new();
        for fact in &mut inner.facts {
            if fact.status != CommandFactStatus::Open {
                continue;
            }
            fact.status = CommandFactStatus::Stale;
            fact.closed_by = Some(closed_by.clone());
            fact.closed_at = Some(now);
            fact.stale_reason = Some(stale_reason.clone());
            changed.push(fact.clone());
        }
        changed
    }
}

fn conservatively_close_previous_open_fact(
    facts: &mut [CommandFact],
    next_fact: &CommandFact,
    now: u64,
) {
    if let Some(previous) = facts.iter_mut().rev().find(|fact| {
        fact.session_id == next_fact.session_id
            && fact.status == CommandFactStatus::Open
            && fact.buffer_generation == next_fact.buffer_generation
            && fact.runtime_epoch == next_fact.runtime_epoch
    }) {
        previous.status = CommandFactStatus::Closed;
        previous.closed_by = Some(CommandFactClosedBy::NextCommand);
        previous.end_global_line = Some(next_fact.start_global_line.saturating_sub(1));
        previous.closed_at = Some(now);
    }
}

fn apply_close_patch(fact: &mut CommandFact, patch: CloseCommandFactPatch, now: u64) {
    let requested_status = patch.status.unwrap_or(CommandFactStatus::Closed);
    fact.status = requested_status;
    fact.end_global_line = patch
        .end_global_line
        .map(|line| line.max(fact.start_global_line))
        .or(fact.end_global_line);
    fact.closed_by = patch.closed_by.or_else(|| fact.closed_by.clone());
    fact.exit_code = patch.exit_code.or(fact.exit_code);
    fact.closed_at = Some(now);
    fact.stale_reason = patch
        .stale_reason
        .as_deref()
        .map(|value| sanitize_text(value, MAX_SOURCE_LENGTH))
        .or_else(|| fact.stale_reason.clone());
}

fn sanitize_optional_text(value: &str) -> String {
    sanitize_text(value, MAX_COMMAND_TEXT_LENGTH)
}

fn sanitize_text(value: &str, max_len: usize) -> String {
    value
        .chars()
        .filter(|ch| *ch == '\n' || *ch == '\t' || !ch.is_control())
        .take(max_len)
        .collect()
}

fn now_millis() -> u64 {
    Utc::now().timestamp_millis().max(0) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity() -> BufferLineIdentity {
        BufferLineIdentity {
            current_lines: 10,
            total_lines: 20,
            base_global_line: 10,
            buffer_generation: 2,
        }
    }

    fn request(client_mark_id: &str, line: u64) -> CreateCommandFactRequest {
        CreateCommandFactRequest {
            client_mark_id: Some(client_mark_id.to_string()),
            correlation_id: None,
            node_id: Some("node-1".to_string()),
            source: CommandFactSource::CommandBar,
            submitted_by: None,
            command: Some("ls -la".to_string()),
            cwd: Some("/tmp".to_string()),
            start_global_line: line,
            command_global_line: line,
            output_start_global_line: Some(line + 1),
            runtime_epoch: Some("epoch-1".to_string()),
            confidence: Some(CommandFactConfidence::High),
        }
    }

    #[tokio::test]
    async fn generated_fact_id_is_authoritative() {
        let store = CommandFactStore::new();
        let fact = store
            .create_fact("session-1", request("client-1", 12), identity())
            .await;

        assert_ne!(fact.fact_id, "client-1");
        assert_eq!(fact.client_mark_id.as_deref(), Some("client-1"));
        assert_eq!(fact.buffer_generation, 2);
    }

    #[tokio::test]
    async fn next_command_conservatively_closes_previous_open_fact() {
        let store = CommandFactStore::new();
        let first = store
            .create_fact("session-1", request("client-1", 12), identity())
            .await;
        store
            .create_fact("session-1", request("client-2", 15), identity())
            .await;

        let closed = store.get_fact(&first.fact_id).await.unwrap();
        assert_eq!(closed.status, CommandFactStatus::Closed);
        assert_eq!(closed.closed_by, Some(CommandFactClosedBy::NextCommand));
        assert_eq!(closed.end_global_line, Some(14));
    }

    #[tokio::test]
    async fn close_fact_can_mark_stale() {
        let store = CommandFactStore::new();
        let fact = store
            .create_fact("session-1", request("client-1", 12), identity())
            .await;
        let closed = store
            .close_fact(
                &fact.fact_id,
                CloseCommandFactPatch {
                    end_global_line: Some(13),
                    closed_by: Some(CommandFactClosedBy::TerminalReset),
                    exit_code: None,
                    status: Some(CommandFactStatus::Stale),
                    stale_reason: Some("terminal_reset".to_string()),
                },
            )
            .await
            .unwrap();

        assert_eq!(closed.status, CommandFactStatus::Stale);
        assert_eq!(closed.end_global_line, Some(13));
        assert_eq!(closed.stale_reason.as_deref(), Some("terminal_reset"));
    }

    #[tokio::test]
    async fn range_query_intersects_closed_facts() {
        let store = CommandFactStore::new();
        let fact = store
            .create_fact("session-1", request("client-1", 12), identity())
            .await;
        store
            .close_fact(
                &fact.fact_id,
                CloseCommandFactPatch {
                    end_global_line: Some(16),
                    closed_by: Some(CommandFactClosedBy::ShellIntegration),
                    exit_code: Some(0),
                    status: None,
                    stale_reason: None,
                },
            )
            .await;

        assert_eq!(store.query_facts(15, 20).await.len(), 1);
        assert_eq!(store.query_facts(17, 20).await.len(), 0);
    }

    #[tokio::test]
    async fn mark_open_facts_stale_only_changes_open_facts() {
        let store = CommandFactStore::new();
        let first = store
            .create_fact("session-1", request("client-1", 12), identity())
            .await;
        store
            .close_fact(
                &first.fact_id,
                CloseCommandFactPatch {
                    end_global_line: Some(13),
                    closed_by: Some(CommandFactClosedBy::Manual),
                    exit_code: None,
                    status: None,
                    stale_reason: None,
                },
            )
            .await;
        let second = store
            .create_fact("session-1", request("client-2", 15), identity())
            .await;

        let changed = store
            .mark_open_facts_stale("clear_buffer", CommandFactClosedBy::TerminalReset)
            .await;

        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0].fact_id, second.fact_id);
        assert_eq!(changed[0].status, CommandFactStatus::Stale);
    }
}
