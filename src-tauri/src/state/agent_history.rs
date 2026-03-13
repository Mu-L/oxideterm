//! Agent Task History persistence using redb
//!
//! Stores agent task history as opaque JSON blobs (compressed with zstd).
//! Frontend owns the schema — Rust only handles storage, compression, and LRU eviction.
//!
//! Database: agent_history.redb
//! Tables:
//!   - agent_tasks: task_id -> zstd-compressed JSON bytes
//!   - agent_task_index: "index" -> MessagePack Vec<task_id> (newest first)

use redb::{Database, ReadableTable, TableDefinition};
use std::path::PathBuf;
use std::sync::Arc;
use thiserror::Error;
use tracing::{error, info, warn};

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

/// Maximum tasks to keep (LRU eviction)
pub const MAX_TASKS: usize = 100;

/// Compression level for zstd (fast, reasonable ratio)
const ZSTD_LEVEL: i32 = 3;

// ═══════════════════════════════════════════════════════════════════════════
// Table Definitions
// ═══════════════════════════════════════════════════════════════════════════

/// Table: agent_tasks (key: task_id, value: zstd-compressed JSON bytes)
const TASKS_TABLE: TableDefinition<&str, &[u8]> = TableDefinition::new("agent_tasks");

/// Table: agent_task_index (key: "index", value: MessagePack Vec<String>)
const INDEX_TABLE: TableDefinition<&str, &[u8]> = TableDefinition::new("agent_task_index");

const INDEX_KEY: &str = "index";

// ═══════════════════════════════════════════════════════════════════════════
// Error Types
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Debug, Error)]
pub enum AgentHistoryError {
    #[error("Database error: {0}")]
    Database(#[from] redb::DatabaseError),

    #[error("Transaction error: {0}")]
    Transaction(#[from] redb::TransactionError),

    #[error("Table error: {0}")]
    Table(#[from] redb::TableError),

    #[error("Storage error: {0}")]
    Storage(#[from] redb::StorageError),

    #[error("Commit error: {0}")]
    Commit(#[from] redb::CommitError),

    #[error("Serialization error: {0}")]
    Serialization(String),

    #[error("Compression error: {0}")]
    Compression(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Task not found: {0}")]
    NotFound(String),
}

impl From<rmp_serde::encode::Error> for AgentHistoryError {
    fn from(e: rmp_serde::encode::Error) -> Self {
        AgentHistoryError::Serialization(e.to_string())
    }
}

impl From<rmp_serde::decode::Error> for AgentHistoryError {
    fn from(e: rmp_serde::decode::Error) -> Self {
        AgentHistoryError::Serialization(e.to_string())
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Agent History Store
// ═══════════════════════════════════════════════════════════════════════════

/// Agent task history persistence store
pub struct AgentHistoryStore {
    db: Arc<Database>,
}

impl AgentHistoryStore {
    /// Open or create the agent history database at the given path
    pub fn new(path: PathBuf) -> Result<Self, AgentHistoryError> {
        let db = match Database::create(&path) {
            Ok(db) => {
                info!("Agent history database opened at {:?}", path);
                db
            }
            Err(e) => {
                warn!("Failed to open agent history database: {:?}, attempting recovery", e);

                let backup_path = path.with_extension("redb.backup");
                if let Err(e) = std::fs::rename(&path, &backup_path) {
                    error!("Failed to backup corrupted agent history database: {:?}", e);
                } else {
                    info!("Backed up corrupted agent history database to {:?}", backup_path);
                }

                Database::create(&path)?
            }
        };

        // Set file permissions to 600 (owner read/write only)
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Err(e) = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)) {
                warn!("Failed to set agent history database permissions: {:?}", e);
            }
        }

        // Initialize tables
        let txn = db.begin_write()?;
        {
            let _ = txn.open_table(TASKS_TABLE)?;
            let _ = txn.open_table(INDEX_TABLE)?;
        }
        txn.commit()?;

        Ok(Self { db: Arc::new(db) })
    }

    /// Save a task as a JSON string. Compresses and stores, enforces LRU limit.
    pub fn save_task(&self, task_id: &str, task_json: &str) -> Result<(), AgentHistoryError> {
        let compressed = zstd::encode_all(task_json.as_bytes(), ZSTD_LEVEL)
            .map_err(|e| AgentHistoryError::Compression(format!("zstd encode failed: {}", e)))?;

        let txn = self.db.begin_write()?;
        {
            let mut tasks = txn.open_table(TASKS_TABLE)?;
            tasks.insert(task_id, compressed.as_slice())?;

            // Update index: prepend new task_id if not already present
            let mut index_table = txn.open_table(INDEX_TABLE)?;
            let mut index = self.read_index_from_table(&index_table)?;

            // Remove existing entry if present (dedup before prepend)
            index.retain(|id| id != task_id);
            index.insert(0, task_id.to_string());

            // Enforce LRU limit: remove oldest tasks
            while index.len() > MAX_TASKS {
                if let Some(old_id) = index.pop() {
                    let _ = tasks.remove(old_id.as_str());
                }
            }

            let index_bytes = rmp_serde::to_vec(&index)?;
            index_table.insert(INDEX_KEY, index_bytes.as_slice())?;
        }
        txn.commit()?;

        Ok(())
    }

    /// List task IDs (newest first), up to `limit`.
    pub fn list_task_ids(&self, limit: usize) -> Result<Vec<String>, AgentHistoryError> {
        let txn = self.db.begin_read()?;
        let index_table = txn.open_table(INDEX_TABLE)?;
        let index = self.read_index_from_table(&index_table)?;
        Ok(index.into_iter().take(limit).collect())
    }

    /// Get a single task's JSON by ID
    pub fn get_task(&self, task_id: &str) -> Result<String, AgentHistoryError> {
        let txn = self.db.begin_read()?;
        let tasks = txn.open_table(TASKS_TABLE)?;
        let entry = tasks
            .get(task_id)?
            .ok_or_else(|| AgentHistoryError::NotFound(task_id.to_string()))?;

        let decompressed = zstd::decode_all(entry.value())
            .map_err(|e| AgentHistoryError::Compression(format!("zstd decode failed: {}", e)))?;

        String::from_utf8(decompressed)
            .map_err(|e| AgentHistoryError::Compression(format!("UTF-8 decode failed: {}", e)))
    }

    /// List tasks as JSON strings (newest first), up to `limit`.
    pub fn list_tasks(&self, limit: usize) -> Result<Vec<String>, AgentHistoryError> {
        let txn = self.db.begin_read()?;
        let index_table = txn.open_table(INDEX_TABLE)?;
        let tasks_table = txn.open_table(TASKS_TABLE)?;

        let index = self.read_index_from_table(&index_table)?;

        let mut results = Vec::new();
        for task_id in index.into_iter().take(limit) {
            match tasks_table.get(task_id.as_str())? {
                Some(entry) => {
                    match zstd::decode_all(entry.value()) {
                        Ok(decompressed) => {
                            match String::from_utf8(decompressed) {
                                Ok(json) => results.push(json),
                                Err(e) => warn!("Skipping task {} (UTF-8 error): {}", task_id, e),
                            }
                        }
                        Err(e) => warn!("Skipping task {} (decompression error): {}", task_id, e),
                    }
                }
                None => warn!("Task {} in index but not in tasks table", task_id),
            }
        }

        Ok(results)
    }

    /// Delete a single task by ID
    pub fn delete_task(&self, task_id: &str) -> Result<(), AgentHistoryError> {
        let txn = self.db.begin_write()?;
        {
            let mut tasks = txn.open_table(TASKS_TABLE)?;
            tasks.remove(task_id)?;

            let mut index_table = txn.open_table(INDEX_TABLE)?;
            let mut index = self.read_index_from_table(&index_table)?;
            index.retain(|id| id != task_id);
            let index_bytes = rmp_serde::to_vec(&index)?;
            index_table.insert(INDEX_KEY, index_bytes.as_slice())?;
        }
        txn.commit()?;
        Ok(())
    }

    /// Clear all tasks
    pub fn clear(&self) -> Result<(), AgentHistoryError> {
        let txn = self.db.begin_write()?;
        {
            // Read index to get all task IDs, then delete each one
            let index_table = txn.open_table(INDEX_TABLE)?;
            let index = self.read_index_from_table(&index_table)?;
            drop(index_table);

            let mut tasks = txn.open_table(TASKS_TABLE)?;
            for id in &index {
                let _ = tasks.remove(id.as_str());
            }

            // Reset the index to empty
            let mut index_table = txn.open_table(INDEX_TABLE)?;
            let empty: Vec<String> = Vec::new();
            let index_bytes = rmp_serde::to_vec(&empty)?;
            index_table.insert(INDEX_KEY, index_bytes.as_slice())?;
        }
        txn.commit()?;
        info!("Agent history cleared");
        Ok(())
    }

    // ─── Internal helpers ────────────────────────────────────────────────

    fn read_index_from_table<T: ReadableTable<&'static str, &'static [u8]>>(
        &self,
        table: &T,
    ) -> Result<Vec<String>, AgentHistoryError> {
        match table.get(INDEX_KEY)? {
            Some(entry) => {
                let index: Vec<String> = rmp_serde::from_slice(entry.value())?;
                Ok(index)
            }
            None => Ok(Vec::new()),
        }
    }
}
