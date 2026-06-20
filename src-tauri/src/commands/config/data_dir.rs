// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

use serde::Serialize;

#[derive(Serialize)]
pub struct DataDirInfo {
    pub path: String,
    pub is_custom: bool,
    pub default_path: String,
    pub is_portable: bool,
    pub can_change: bool,
}

/// Get current data directory information.
#[tauri::command]
pub async fn get_data_directory() -> Result<DataDirInfo, String> {
    let info = crate::config::storage::get_data_dir_info().map_err(|e| e.to_string())?;

    Ok(DataDirInfo {
        path: info.effective.to_string_lossy().to_string(),
        is_custom: info.is_custom,
        default_path: info.default.to_string_lossy().to_string(),
        is_portable: info.is_portable,
        can_change: info.can_change,
    })
}

/// Set a custom data directory. Returns true when an app restart is required.
#[tauri::command]
pub async fn set_data_directory(new_path: String) -> Result<bool, String> {
    if crate::config::is_portable_mode().map_err(|e| e.to_string())? {
        return Err("Data directory cannot be changed in portable mode".to_string());
    }

    let path = std::path::PathBuf::from(&new_path);

    if !path.is_absolute() {
        return Err("Data directory must be an absolute path".to_string());
    }

    if path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("Data directory path must not contain '..'".to_string());
    }

    std::fs::create_dir_all(&path).map_err(|e| format!("Failed to create directory: {}", e))?;

    let canonical = path
        .canonicalize()
        .map_err(|e| format!("Failed to resolve path: {}", e))?;

    let test_filename = format!(".oxideterm_test_{}", std::process::id());
    let test_file = canonical.join(&test_filename);
    std::fs::write(&test_file, b"test").map_err(|e| format!("Directory is not writable: {}", e))?;
    if let Err(e) = std::fs::remove_file(&test_file) {
        tracing::warn!("Failed to remove write test file {:?}: {}", test_file, e);
    }

    let canonical = crate::config::storage::user_visible_data_dir_path(canonical);
    let canonical_str = canonical.to_string_lossy().to_string();
    let bootstrap = crate::config::storage::BootstrapConfig::new_with_data_dir(canonical_str);
    tokio::task::spawn_blocking(move || crate::config::storage::save_bootstrap_config(&bootstrap))
        .await
        .map_err(|e| format!("Task failed: {}", e))?
        .map_err(|e| e.to_string())?;

    Ok(true)
}

/// Reset data directory to default. Removes data_dir from bootstrap.json.
#[tauri::command]
pub async fn reset_data_directory() -> Result<bool, String> {
    if crate::config::is_portable_mode().map_err(|e| e.to_string())? {
        return Err("Data directory cannot be reset in portable mode".to_string());
    }

    let bootstrap = crate::config::storage::BootstrapConfig::default();
    tokio::task::spawn_blocking(move || crate::config::storage::save_bootstrap_config(&bootstrap))
        .await
        .map_err(|e| format!("Task failed: {}", e))?
        .map_err(|e| e.to_string())?;
    Ok(true)
}

/// Open the log directory in the system file manager.
#[tauri::command]
pub async fn open_log_directory(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    let log_dir = crate::config::storage::log_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&log_dir)
        .map_err(|e| format!("Failed to create log directory: {}", e))?;
    let path_str = log_dir.to_string_lossy().to_string();
    app.opener()
        .reveal_item_in_dir(&path_str)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Check whether a directory already contains OxideTerm data files.
#[tauri::command]
pub async fn check_data_directory(path: String) -> Result<DataDirCheck, String> {
    let dir = std::path::PathBuf::from(&path);
    if !dir.is_dir() {
        return Ok(DataDirCheck {
            has_existing_data: false,
            files_found: Vec::new(),
        });
    }

    let known_files = [
        "connections.json",
        "state.redb",
        "chat_history.redb",
        "sftp_progress.redb",
        "rag_index.redb",
        "plugin-config.json",
        "bootstrap.json",
        "topology_edges.json",
    ];

    let mut found = Vec::new();
    for name in &known_files {
        if dir.join(name).exists() {
            found.push(name.to_string());
        }
    }
    for subdir in &["logs", "plugins", "rag_hnsw.bin"] {
        if dir.join(subdir).exists() {
            found.push(subdir.to_string());
        }
    }

    Ok(DataDirCheck {
        has_existing_data: !found.is_empty(),
        files_found: found,
    })
}

#[derive(Serialize)]
pub struct DataDirCheck {
    pub has_existing_data: bool,
    pub files_found: Vec<String>,
}
