// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

//! Portable mode detection and path helpers.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::Manager;

const PORTABLE_MARKER_FILENAME: &str = "portable";
const PORTABLE_DATA_DIRNAME: &str = "data";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortableInfo {
    pub is_portable: bool,
    pub exe_dir: PathBuf,
    pub marker_path: PathBuf,
    pub data_dir: PathBuf,
}

#[derive(Debug, thiserror::Error)]
pub enum PortableError {
    #[error("Failed to determine current executable path: {0}")]
    CurrentExe(#[source] std::io::Error),

    #[error("Executable path has no parent directory: {0}")]
    MissingExeParent(PathBuf),

    #[error("Failed to get app data dir: {0}")]
    AppDataDir(String),
}

static PORTABLE_INFO: OnceLock<PortableInfo> = OnceLock::new();

pub fn detect_portable_info_from_exe(exe_path: &Path) -> Result<PortableInfo, PortableError> {
    let exe_dir = exe_path
        .parent()
        .ok_or_else(|| PortableError::MissingExeParent(exe_path.to_path_buf()))?
        .to_path_buf();
    let marker_path = exe_dir.join(PORTABLE_MARKER_FILENAME);
    let data_dir = exe_dir.join(PORTABLE_DATA_DIRNAME);
    #[cfg(target_os = "windows")]
    let is_portable = marker_path.exists();
    #[cfg(not(target_os = "windows"))]
    let is_portable = false;

    Ok(PortableInfo {
        is_portable,
        exe_dir,
        marker_path,
        data_dir,
    })
}

pub fn portable_info() -> Result<&'static PortableInfo, PortableError> {
    if let Some(info) = PORTABLE_INFO.get() {
        return Ok(info);
    }

    let exe_path = std::env::current_exe().map_err(PortableError::CurrentExe)?;
    let detected = detect_portable_info_from_exe(&exe_path)?;
    Ok(PORTABLE_INFO.get_or_init(|| detected))
}

pub fn is_portable_mode() -> Result<bool, PortableError> {
    Ok(portable_info()?.is_portable)
}

pub fn portable_data_dir() -> Result<Option<PathBuf>, PortableError> {
    let info = portable_info()?;
    Ok(info.is_portable.then(|| info.data_dir.clone()))
}

pub fn portable_aware_app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, PortableError> {
    if let Some(data_dir) = portable_data_dir()? {
        return Ok(data_dir);
    }

    app.path()
        .app_data_dir()
        .map_err(|e: tauri::Error| PortableError::AppDataDir(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn marker_only_enables_portable_mode_on_windows() {
        let temp = tempdir().unwrap();
        let exe_path = temp.path().join("OxideTerm.exe");
        std::fs::write(&exe_path, b"").unwrap();
        std::fs::write(temp.path().join(PORTABLE_MARKER_FILENAME), b"").unwrap();

        let info = detect_portable_info_from_exe(&exe_path).unwrap();

        #[cfg(target_os = "windows")]
        assert!(info.is_portable);
        #[cfg(not(target_os = "windows"))]
        assert!(!info.is_portable);
        assert_eq!(info.exe_dir, temp.path());
        assert_eq!(info.marker_path, temp.path().join(PORTABLE_MARKER_FILENAME));
        assert_eq!(info.data_dir, temp.path().join(PORTABLE_DATA_DIRNAME));
    }

    #[test]
    fn missing_marker_stays_in_normal_mode() {
        let temp = tempdir().unwrap();
        let exe_path = temp.path().join("OxideTerm.exe");
        std::fs::write(&exe_path, b"").unwrap();

        let info = detect_portable_info_from_exe(&exe_path).unwrap();

        assert!(!info.is_portable);
        assert_eq!(info.marker_path, temp.path().join(PORTABLE_MARKER_FILENAME));
        assert_eq!(info.data_dir, temp.path().join(PORTABLE_DATA_DIRNAME));
    }
}
