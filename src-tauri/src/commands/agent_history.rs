//! Agent Task History Commands
//!
//! Tauri IPC commands for persisting and querying agent task history.
//! Tasks are stored as opaque JSON strings — the frontend owns the schema.

use crate::state::AgentHistoryStore;
use std::sync::Arc;
use tauri::State;

/// Save an agent task to persistent storage.
/// `task_id` is extracted from the JSON for indexing.
#[tauri::command]
pub async fn agent_history_save(
    task_id: String,
    task_json: String,
    store: State<'_, Arc<AgentHistoryStore>>,
) -> Result<(), String> {
    store
        .save_task(&task_id, &task_json)
        .map_err(|e| format!("Failed to save agent task: {}", e))
}

/// List recent agent tasks as JSON strings (newest first).
#[tauri::command]
pub async fn agent_history_list(
    limit: u32,
    store: State<'_, Arc<AgentHistoryStore>>,
) -> Result<Vec<String>, String> {
    store
        .list_tasks(limit as usize)
        .map_err(|e| format!("Failed to list agent tasks: {}", e))
}

/// Delete a single agent task by ID.
#[tauri::command]
pub async fn agent_history_delete(
    task_id: String,
    store: State<'_, Arc<AgentHistoryStore>>,
) -> Result<(), String> {
    store
        .delete_task(&task_id)
        .map_err(|e| format!("Failed to delete agent task: {}", e))
}

/// Clear all agent task history.
#[tauri::command]
pub async fn agent_history_clear(
    store: State<'_, Arc<AgentHistoryStore>>,
) -> Result<(), String> {
    store
        .clear()
        .map_err(|e| format!("Failed to clear agent history: {}", e))
}
