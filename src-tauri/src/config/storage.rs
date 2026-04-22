// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

//! Configuration Storage
//!
//! Handles reading/writing configuration files to disk.
//! Config location: ~/.oxideterm on macOS/Linux, %APPDATA%\OxideTerm on Windows
//!
//! Supports configurable data directory via bootstrap.json at the default location.
//! If `~/.oxideterm/bootstrap.json` contains `{ "data_dir": "/custom/path" }`,
//! all data files will be stored at that custom path instead.

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use chacha20poly1305::{ChaCha20Poly1305, KeyInit, Nonce, aead::Aead};
use rand::RngCore;
use std::path::PathBuf;
use std::sync::OnceLock;
use tokio::fs;
use tokio::io::AsyncWriteExt;
use zeroize::Zeroizing;

use super::portable::{is_portable_mode, portable_data_dir};
use super::types::{CONFIG_VERSION, ConfigFile};

const ENCRYPTED_CONFIG_FORMAT: &str = "oxideterm.config.encrypted";
const ENCRYPTED_CONFIG_VERSION: u32 = 1;
const ENCRYPTED_CONFIG_ALGORITHM: &str = "chacha20poly1305";
pub const CONFIG_ENCRYPTION_KEY_LEN: usize = 32;
const CONFIG_ENCRYPTION_NONCE_LEN: usize = 12;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigStorageFormat {
    Missing,
    Plaintext,
    Encrypted,
    RecoveredDefault,
}

#[derive(Debug, Clone)]
pub struct LoadedConfig {
    pub config: ConfigFile,
    pub format: ConfigStorageFormat,
}

#[derive(Debug, Clone)]
pub struct ResolvedDataDirInfo {
    pub effective: PathBuf,
    pub default: PathBuf,
    pub is_custom: bool,
    pub is_portable: bool,
    pub can_change: bool,
}

#[derive(Debug, serde::Deserialize, serde::Serialize)]
struct EncryptedConfigEnvelope {
    format: String,
    version: u32,
    algorithm: String,
    nonce: String,
    ciphertext: String,
}

/// Configuration storage errors
#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("Failed to determine config directory")]
    NoConfigDir,

    #[error("Portable mode error: {0}")]
    Portable(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("MessagePack encode error: {0}")]
    MsgPackEncode(#[from] rmp_serde::encode::Error),

    #[error("MessagePack decode error: {0}")]
    MsgPackDecode(#[from] rmp_serde::decode::Error),

    #[error("Base64 error: {0}")]
    Base64(#[from] base64::DecodeError),

    #[error("Config version {found} is newer than supported {supported}")]
    VersionTooNew { found: u32, supported: u32 },

    #[error(
        "Encrypted config requires the local config key from the OS keychain; restore the keychain entry or recover from backup"
    )]
    MissingEncryptionKey,

    #[error("Invalid encrypted config format")]
    InvalidEncryptedConfigFormat,

    #[error("Unsupported encrypted config version {found}")]
    UnsupportedEncryptedConfigVersion { found: u32 },

    #[error("Unsupported encrypted config algorithm: {0}")]
    UnsupportedEncryptedConfigAlgorithm(String),

    #[error("Failed to encrypt config")]
    EncryptionFailed,

    #[error("Failed to decrypt config")]
    DecryptionFailed,
}

/// Bootstrap configuration stored at the fixed default location.
/// This file controls where the actual data directory lives.
#[derive(serde::Deserialize, serde::Serialize, Default)]
pub struct BootstrapConfig {
    /// Custom data directory path. If None, uses the default location.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    data_dir: Option<String>,
    /// Last known good Linux WebView startup profile.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    linux_webview_profile: Option<String>,
}

impl BootstrapConfig {
    pub fn new_with_data_dir(path: String) -> Self {
        Self {
            data_dir: Some(path),
            linux_webview_profile: None,
        }
    }

    pub fn linux_webview_profile(&self) -> Option<&str> {
        self.linux_webview_profile.as_deref()
    }

    pub fn set_linux_webview_profile(&mut self, profile: Option<String>) {
        self.linux_webview_profile = profile;
    }
}

/// Cached resolved data directory path
static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Get the default (fixed) OxideTerm directory.
/// This is always the same location regardless of bootstrap config.
/// Bootstrap config file lives here.
pub fn default_dir() -> Result<PathBuf, StorageError> {
    #[cfg(windows)]
    {
        if let Some(app_data) = dirs::config_dir() {
            return Ok(app_data.join("OxideTerm"));
        }
        dirs::home_dir()
            .map(|home| home.join(".oxideterm"))
            .ok_or(StorageError::NoConfigDir)
    }

    #[cfg(not(windows))]
    {
        dirs::home_dir()
            .map(|home| home.join(".oxideterm"))
            .ok_or(StorageError::NoConfigDir)
    }
}

/// Get the bootstrap config file path (always at the default location)
pub fn bootstrap_config_path() -> Result<PathBuf, StorageError> {
    Ok(default_dir()?.join("bootstrap.json"))
}

/// Read the bootstrap config from disk (synchronous, used during init)
fn read_bootstrap_config() -> Option<BootstrapConfig> {
    let path = bootstrap_config_path().ok()?;
    let contents = std::fs::read_to_string(&path).ok()?;
    match serde_json::from_str(&contents) {
        Ok(config) => Some(config),
        Err(e) => {
            tracing::warn!("Failed to parse bootstrap.json: {}", e);
            None
        }
    }
}

/// Read the bootstrap config from disk (synchronous, used during init)
pub fn load_bootstrap_config() -> Option<BootstrapConfig> {
    read_bootstrap_config()
}

/// Save bootstrap config to disk (atomic write)
pub fn save_bootstrap_config(config: &BootstrapConfig) -> Result<(), StorageError> {
    let path = bootstrap_config_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(config)?;
    let temp_path = path.with_extension("json.tmp");
    std::fs::write(&temp_path, json.as_bytes())?;
    std::fs::rename(&temp_path, &path)?;
    Ok(())
}

/// Get the effective OxideTerm data directory.
/// Checks bootstrap.json for a custom data_dir override, caches result.
/// Returns %APPDATA%\OxideTerm on Windows, ~/.oxideterm on macOS/Linux by default.
pub fn config_dir() -> Result<PathBuf, StorageError> {
    if let Some(cached) = DATA_DIR.get() {
        return Ok(cached.clone());
    }

    let resolved = resolve_data_dir()?;
    Ok(DATA_DIR.get_or_init(|| resolved).clone())
}

/// Resolve the data directory by checking bootstrap config
fn resolve_data_dir() -> Result<PathBuf, StorageError> {
    if let Some(data_dir) =
        portable_data_dir().map_err(|e| StorageError::Portable(e.to_string()))?
    {
        tracing::info!("Using portable data directory: {:?}", data_dir);
        return Ok(data_dir);
    }

    if let Some(bootstrap) = read_bootstrap_config() {
        if let Some(custom_dir) = bootstrap.data_dir {
            let path = PathBuf::from(&custom_dir);
            if path.is_absolute() {
                tracing::info!("Using custom data directory: {:?}", path);
                return Ok(path);
            }
            tracing::warn!(
                "Ignoring non-absolute data_dir in bootstrap.json: {:?}",
                custom_dir
            );
        }
    }
    default_dir()
}

/// Get the current effective data directory path and whether it's custom
pub fn get_data_dir_info() -> Result<ResolvedDataDirInfo, StorageError> {
    let effective = config_dir()?;
    let default = default_dir()?;
    let is_portable = is_portable_mode().map_err(|e| StorageError::Portable(e.to_string()))?;
    let is_custom = !is_portable && effective != default;
    Ok(ResolvedDataDirInfo {
        effective,
        default,
        is_custom,
        is_portable,
        can_change: !is_portable,
    })
}

/// Get the log directory for storing application logs
pub fn log_dir() -> Result<PathBuf, StorageError> {
    Ok(config_dir()?.join("logs"))
}

/// Get the connections file path
pub fn connections_file() -> Result<PathBuf, StorageError> {
    Ok(config_dir()?.join("connections.json"))
}

/// Configuration storage manager
pub struct ConfigStorage {
    path: PathBuf,
}

impl ConfigStorage {
    /// Create a new storage manager with default path
    pub fn new() -> Result<Self, StorageError> {
        Ok(Self {
            path: connections_file()?,
        })
    }

    /// Create storage manager with custom path (for testing)
    pub fn with_path(path: PathBuf) -> Self {
        Self { path }
    }

    /// Ensure the config directory exists
    async fn ensure_dir(&self) -> Result<(), StorageError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).await?;
        }
        Ok(())
    }

    fn is_encrypted_document(document: &serde_json::Value) -> bool {
        document.get("format").and_then(serde_json::Value::as_str) == Some(ENCRYPTED_CONFIG_FORMAT)
    }

    fn validate_config_version(config: ConfigFile) -> Result<ConfigFile, StorageError> {
        if config.version > CONFIG_VERSION {
            return Err(StorageError::VersionTooNew {
                found: config.version,
                supported: CONFIG_VERSION,
            });
        }

        Ok(config)
    }

    fn encrypt_config(
        &self,
        config: &ConfigFile,
        key: &[u8; CONFIG_ENCRYPTION_KEY_LEN],
    ) -> Result<EncryptedConfigEnvelope, StorageError> {
        let plaintext = Zeroizing::new(rmp_serde::to_vec_named(config)?);
        let mut nonce = [0u8; CONFIG_ENCRYPTION_NONCE_LEN];
        rand::rngs::OsRng.fill_bytes(&mut nonce);

        let cipher = ChaCha20Poly1305::new_from_slice(key)
            .map_err(|_| StorageError::InvalidEncryptedConfigFormat)?;
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&nonce), plaintext.as_ref())
            .map_err(|_| StorageError::EncryptionFailed)?;

        Ok(EncryptedConfigEnvelope {
            format: ENCRYPTED_CONFIG_FORMAT.to_string(),
            version: ENCRYPTED_CONFIG_VERSION,
            algorithm: ENCRYPTED_CONFIG_ALGORITHM.to_string(),
            nonce: BASE64.encode(nonce),
            ciphertext: BASE64.encode(ciphertext),
        })
    }

    fn decrypt_config(
        &self,
        envelope: EncryptedConfigEnvelope,
        key: &[u8; CONFIG_ENCRYPTION_KEY_LEN],
    ) -> Result<ConfigFile, StorageError> {
        if envelope.format != ENCRYPTED_CONFIG_FORMAT {
            return Err(StorageError::InvalidEncryptedConfigFormat);
        }

        if envelope.version != ENCRYPTED_CONFIG_VERSION {
            return Err(StorageError::UnsupportedEncryptedConfigVersion {
                found: envelope.version,
            });
        }

        if envelope.algorithm != ENCRYPTED_CONFIG_ALGORITHM {
            return Err(StorageError::UnsupportedEncryptedConfigAlgorithm(
                envelope.algorithm,
            ));
        }

        let nonce = BASE64.decode(envelope.nonce)?;
        let nonce: [u8; CONFIG_ENCRYPTION_NONCE_LEN] = nonce
            .try_into()
            .map_err(|_| StorageError::InvalidEncryptedConfigFormat)?;
        let ciphertext = BASE64.decode(envelope.ciphertext)?;

        let cipher = ChaCha20Poly1305::new_from_slice(key)
            .map_err(|_| StorageError::InvalidEncryptedConfigFormat)?;
        let plaintext = Zeroizing::new(
            cipher
                .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
                .map_err(|_| StorageError::DecryptionFailed)?,
        );

        let config: ConfigFile = rmp_serde::from_slice(&plaintext)?;
        Self::validate_config_version(config)
    }

    async fn recover_from_corruption(
        &self,
        err: impl std::fmt::Display,
    ) -> Result<LoadedConfig, StorageError> {
        tracing::warn!("Config file corrupted: {}", err);

        match self.backup().await {
            Ok(backup_path) => {
                tracing::warn!(
                    "Corrupted config backed up to {:?}, using defaults",
                    backup_path
                );
            }
            Err(backup_err) => {
                tracing::error!("Failed to backup corrupted config: {}", backup_err);
            }
        }

        Ok(LoadedConfig {
            config: ConfigFile::default(),
            format: ConfigStorageFormat::RecoveredDefault,
        })
    }

    /// Load configuration from disk.
    /// Returns default config if file doesn't exist.
    /// Supports legacy plaintext JSON and the encrypted envelope format.
    /// Legacy plaintext corruption falls back to defaults after creating a backup.
    pub async fn load_with_key(
        &self,
        key: Option<&[u8; CONFIG_ENCRYPTION_KEY_LEN]>,
    ) -> Result<LoadedConfig, StorageError> {
        match fs::read_to_string(&self.path).await {
            Ok(contents) => {
                let document = match serde_json::from_str::<serde_json::Value>(&contents) {
                    Ok(document) => document,
                    Err(err) => return self.recover_from_corruption(err).await,
                };

                if Self::is_encrypted_document(&document) {
                    let envelope: EncryptedConfigEnvelope = serde_json::from_value(document)
                        .map_err(|_| StorageError::InvalidEncryptedConfigFormat)?;
                    let key = key.ok_or(StorageError::MissingEncryptionKey)?;
                    let config = self.decrypt_config(envelope, key)?;
                    return Ok(LoadedConfig {
                        config,
                        format: ConfigStorageFormat::Encrypted,
                    });
                }

                match serde_json::from_value::<ConfigFile>(document) {
                    Ok(config) => Ok(LoadedConfig {
                        config: Self::validate_config_version(config)?,
                        format: ConfigStorageFormat::Plaintext,
                    }),
                    Err(err) => self.recover_from_corruption(err).await,
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(LoadedConfig {
                config: ConfigFile::default(),
                format: ConfigStorageFormat::Missing,
            }),
            Err(e) => Err(StorageError::Io(e)),
        }
    }

    /// Save configuration to disk as an encrypted JSON envelope.
    pub async fn save_encrypted(
        &self,
        config: &ConfigFile,
        key: &[u8; CONFIG_ENCRYPTION_KEY_LEN],
    ) -> Result<(), StorageError> {
        self.ensure_dir().await?;

        // Write to temp file first, then rename (atomic write)
        let temp_path = self.path.with_extension("json.tmp");
        let envelope = self.encrypt_config(config, key)?;
        let json = serde_json::to_string_pretty(&envelope)?;

        let mut file = fs::File::create(&temp_path).await?;
        file.write_all(json.as_bytes()).await?;
        file.sync_all().await?;

        fs::rename(&temp_path, &self.path).await?;

        Ok(())
    }

    /// Check if config file exists
    pub async fn exists(&self) -> bool {
        fs::metadata(&self.path).await.is_ok()
    }

    /// Get config file path
    pub fn path(&self) -> &PathBuf {
        &self.path
    }

    /// Create a backup of the current config
    pub async fn backup(&self) -> Result<PathBuf, StorageError> {
        let backup_path = self.path.with_extension(format!(
            "json.backup.{}",
            chrono::Utc::now().format("%Y%m%d_%H%M%S")
        ));

        if self.exists().await {
            fs::copy(&self.path, &backup_path).await?;
        }

        Ok(backup_path)
    }
}

impl Default for ConfigStorage {
    fn default() -> Self {
        Self::new().unwrap_or_else(|e| {
            panic!(
                "Failed to create ConfigStorage with default path: {}. \
                This is likely a system configuration issue.",
                e
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn test_key() -> [u8; CONFIG_ENCRYPTION_KEY_LEN] {
        [7u8; CONFIG_ENCRYPTION_KEY_LEN]
    }

    #[tokio::test]
    async fn test_load_nonexistent() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("test.json");
        let storage = ConfigStorage::with_path(path);

        let loaded = storage.load_with_key(None).await.unwrap();
        assert_eq!(loaded.config.version, CONFIG_VERSION);
        assert!(loaded.config.connections.is_empty());
        assert_eq!(loaded.format, ConfigStorageFormat::Missing);
    }

    #[tokio::test]
    async fn test_save_and_load_encrypted() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("test.json");
        let storage = ConfigStorage::with_path(path);

        let mut config = ConfigFile::default();
        config.groups.push("Work".to_string());

        storage.save_encrypted(&config, &test_key()).await.unwrap();

        let raw = fs::read_to_string(storage.path()).await.unwrap();
        assert!(!raw.contains("Work"));

        let loaded = storage.load_with_key(Some(&test_key())).await.unwrap();
        assert_eq!(loaded.config.groups, vec!["Work"]);
        assert_eq!(loaded.format, ConfigStorageFormat::Encrypted);
    }

    #[tokio::test]
    async fn test_load_legacy_plaintext() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("test.json");
        let storage = ConfigStorage::with_path(path.clone());

        let mut config = ConfigFile::default();
        config.groups.push("Work".to_string());
        fs::write(path, serde_json::to_string_pretty(&config).unwrap())
            .await
            .unwrap();

        let loaded = storage.load_with_key(None).await.unwrap();
        assert_eq!(loaded.config.groups, vec!["Work"]);
        assert_eq!(loaded.format, ConfigStorageFormat::Plaintext);
    }

    #[tokio::test]
    async fn test_encrypted_load_requires_key() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("test.json");
        let storage = ConfigStorage::with_path(path);

        storage
            .save_encrypted(&ConfigFile::default(), &test_key())
            .await
            .unwrap();

        let err = storage.load_with_key(None).await.unwrap_err();
        assert!(matches!(err, StorageError::MissingEncryptionKey));
    }

    #[test]
    fn portable_storage_error_has_explicit_variant() {
        let err = StorageError::Portable("marker lookup failed".to_string());
        assert_eq!(err.to_string(), "Portable mode error: marker lookup failed");
    }

    #[test]
    fn resolved_data_dir_info_can_represent_portable_mode() {
        let info = ResolvedDataDirInfo {
            effective: PathBuf::from("/portable/data"),
            default: PathBuf::from("/home/user/.oxideterm"),
            is_custom: false,
            is_portable: true,
            can_change: false,
        };

        assert!(info.is_portable);
        assert!(!info.is_custom);
        assert!(!info.can_change);
    }

    #[test]
    fn bootstrap_config_round_trips_linux_webview_profile() {
        let json = r#"{
          "data_dir": "/tmp/oxideterm-data",
          "linux_webview_profile": "safe"
        }"#;

        let config: BootstrapConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.linux_webview_profile(), Some("safe"));

        let serialized = serde_json::to_string(&config).unwrap();
        assert!(serialized.contains("\"linux_webview_profile\":\"safe\""));
        assert!(serialized.contains("\"data_dir\":\"/tmp/oxideterm-data\""));
    }
}
