// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

//! Portable mode inspection commands.

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableInfoResponse {
    pub is_portable: bool,
    pub exe_dir: String,
    pub marker_path: String,
    pub data_dir: String,
}

#[tauri::command]
pub async fn get_portable_info() -> Result<PortableInfoResponse, String> {
    let info = crate::config::portable_info().map_err(|e| e.to_string())?;

    Ok(PortableInfoResponse {
        is_portable: info.is_portable,
        exe_dir: info.exe_dir.to_string_lossy().to_string(),
        marker_path: info.marker_path.to_string_lossy().to_string(),
        data_dir: info.data_dir.to_string_lossy().to_string(),
    })
}
