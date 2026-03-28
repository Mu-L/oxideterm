//! Keychain Integration
//!
//! Securely stores passwords and passphrases in the system keychain.
//! Uses the `keyring` crate for cross-platform keychain access.
//!
//! ## macOS AI Keychain
//!
//! When `use_biometrics` is enabled (AI API keys), macOS uses the `security`
//! CLI tool with the `-A` flag instead of the `keyring` crate. This avoids
//! the keychain password dialog that appears every time `tauri dev` rebuilds
//! the binary (macOS login keychain has per-binary ACLs).
//!
//! Security is provided by:
//! 1. **Touch ID** via `LAContext` (see `touch_id.rs`) — gates reads
//! 2. **In-memory cache** in `ConfigState` — limits reads to once per session
//!
//! Keychain ACLs are intentionally relaxed (any app can access) because
//! the above layers already provide sufficient protection.

use keyring::Entry;
use uuid::Uuid;

/// Service name for keychain entries
const SERVICE_NAME: &str = "com.oxideterm.ssh";

// ─── macOS: security CLI wrapper ─────────────────────────────────────────────

/// On macOS, use the `security` CLI with `-A` (allow-all-apps) ACL for the
/// biometric-gated AI keychain. This avoids the per-binary keychain password
/// dialog that the `keyring` crate triggers after every `tauri dev` rebuild.
#[cfg(target_os = "macos")]
mod mac_keychain {
    use std::process::Command;

    /// Store a secret using `security add-generic-password -A`.
    /// Deletes any existing entry first, then re-creates with permissive ACL.
    pub fn store(service: &str, account: &str, password: &str) -> Result<(), String> {
        // Remove existing entry (ignore "not found" errors)
        let _ = Command::new("security")
            .args(["delete-generic-password", "-s", service, "-a", account])
            .output();

        let output = Command::new("security")
            .args([
                "add-generic-password",
                "-s", service,
                "-a", account,
                "-w", password,
                "-A",  // allow any application — security is via Touch ID, not ACL
            ])
            .output()
            .map_err(|e| format!("security CLI: {}", e))?;

        if output.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!("security add-generic-password: {}", stderr.trim()))
        }
    }

    /// Read a secret using `security find-generic-password -w`.
    pub fn get(service: &str, account: &str) -> Result<String, String> {
        let output = Command::new("security")
            .args(["find-generic-password", "-s", service, "-a", account, "-w"])
            .output()
            .map_err(|e| format!("security CLI: {}", e))?;

        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout)
                .trim_end_matches('\n')
                .to_string())
        } else {
            Err("not found".to_string())
        }
    }

    /// Delete a secret.
    pub fn delete(service: &str, account: &str) -> Result<(), String> {
        let output = Command::new("security")
            .args(["delete-generic-password", "-s", service, "-a", account])
            .output()
            .map_err(|e| format!("security CLI: {}", e))?;

        if output.status.success() {
            Ok(())
        } else {
            // Treat "not found" as success
            Ok(())
        }
    }

    /// Check if a secret exists (without reading the password → no ACL prompt).
    pub fn exists(service: &str, account: &str) -> bool {
        // find-generic-password WITHOUT -w just checks metadata, no ACL check
        Command::new("security")
            .args(["find-generic-password", "-s", service, "-a", account])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
}

/// Keychain errors
#[derive(Debug, thiserror::Error)]
pub enum KeychainError {
    #[error("Keychain error: {0}")]
    Keyring(#[from] keyring::Error),

    #[error("Secret not found for ID: {0}")]
    NotFound(String),
}

/// Keychain manager for storing SSH credentials.
///
/// By default, uses the cross-platform `keyring` crate.
/// On macOS, can optionally gate **reads** behind Touch ID authentication
/// using `LAContext` (LocalAuthentication framework). Storage always goes
/// through the regular `keyring` crate — no `SecAccessControl` entitlements needed.
pub struct Keychain {
    service: String,
    /// When true (macOS only), `get()` will prompt Touch ID before returning
    /// the secret. Store/delete/exists use keyring directly without auth.
    #[cfg(target_os = "macos")]
    use_biometrics: bool,
}

impl Keychain {
    /// Create a new keychain manager (SSH passwords — no biometric).
    pub fn new() -> Self {
        Self {
            service: SERVICE_NAME.to_string(),
            #[cfg(target_os = "macos")]
            use_biometrics: false,
        }
    }

    /// Create with custom service name (no biometric).
    pub fn with_service(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
            #[cfg(target_os = "macos")]
            use_biometrics: false,
        }
    }

    /// Create with Touch ID authentication for reads.
    ///
    /// On macOS: `get()` calls will prompt Touch ID (or device passcode)
    /// before returning the secret. Uses `LAContext` from the
    /// `LocalAuthentication` framework — no code-signing entitlements needed.
    /// Secrets are stored in the regular keyring, not the Data Protection Keychain.
    ///
    /// On non-macOS platforms: identical to [`Self::with_service`].
    pub fn with_biometrics(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
            #[cfg(target_os = "macos")]
            use_biometrics: true,
        }
    }

    /// Generate a new unique keychain ID
    pub fn generate_id() -> String {
        format!("oxideterm-{}", Uuid::new_v4())
    }

    /// Store a secret in the keychain.
    ///
    /// On macOS with biometric mode: uses `security` CLI with `-A` ACL to
    /// avoid per-binary keychain password dialogs.
    /// Otherwise: uses the cross-platform `keyring` crate.
    pub fn store(&self, id: &str, secret: &str) -> Result<(), KeychainError> {
        tracing::info!("Keychain store: service={}, id={}", self.service, id);

        #[cfg(target_os = "macos")]
        if self.use_biometrics {
            let username = whoami::username();
            let account = format!("{}@{}", username, id);
            mac_keychain::store(&self.service, &account, secret).map_err(|e| {
                tracing::error!("mac_keychain store failed: {}", e);
                KeychainError::Keyring(keyring::Error::PlatformFailure(e.into()))
            })?;
            tracing::info!("Keychain store via security CLI: id={}", id);
            return Ok(());
        }

        // Non-biometric path: use keyring crate
        let username = whoami::username();
        let entry = Entry::new(&self.service, &format!("{}@{}", username, id))?;
        match entry.set_password(secret) {
            Ok(()) => {
                tracing::info!("Keychain store called successfully, verifying...");
                match entry.get_password() {
                    Ok(read_back) => {
                        if read_back == secret {
                            tracing::info!("Keychain store verified: id={}", id);
                            Ok(())
                        } else {
                            tracing::error!("Keychain store verification failed: content mismatch");
                            Err(KeychainError::Keyring(keyring::Error::NoEntry))
                        }
                    }
                    Err(e) => {
                        tracing::error!("Keychain store verification failed: {:?}", e);
                        Err(KeychainError::Keyring(e))
                    }
                }
            }
            Err(e) => {
                tracing::error!("Keychain store failed: id={}, error={:?}", id, e);
                Err(KeychainError::Keyring(e))
            }
        }
    }

    /// Store a new secret and return its generated ID
    pub fn store_new(&self, secret: &str) -> Result<String, KeychainError> {
        let id = Self::generate_id();
        self.store(&id, secret)?;
        Ok(id)
    }

    /// Retrieve a secret from the keychain.
    ///
    /// When biometric mode is active (macOS), prompts Touch ID then reads
    /// via `security` CLI (permissive ACL, no keychain password dialog).
    /// If an older entry exists with restrictive ACL, it is automatically
    /// migrated to the permissive format after a successful read.
    pub fn get(&self, id: &str) -> Result<String, KeychainError> {
        #[cfg(target_os = "macos")]
        if self.use_biometrics {
            // Touch ID gate
            if super::touch_id::is_biometric_available() {
                match super::touch_id::authenticate("OxideTerm needs to access your AI API key") {
                    Ok(()) => {
                        tracing::debug!("Touch ID authentication succeeded for id={}", id);
                    }
                    Err(e) => {
                        tracing::warn!("Touch ID authentication failed for id={}: {}", id, e);
                        return Err(KeychainError::Keyring(keyring::Error::PlatformFailure(
                            format!("Touch ID: {}", e).into(),
                        )));
                    }
                }
            } else {
                tracing::debug!("Touch ID not available, skipping biometric auth for id={}", id);
            }

            let username = whoami::username();
            let account = format!("{}@{}", username, id);

            // Try reading via security CLI (works without dialog for -A items)
            match mac_keychain::get(&self.service, &account) {
                Ok(secret) => {
                    tracing::info!("Keychain get via security CLI: id={}, len={}", id, secret.len());
                    // Migrate: re-store with -A ACL so future reads never prompt
                    let _ = mac_keychain::store(&self.service, &account, &secret);
                    return Ok(secret);
                }
                Err(_) => {
                    // Item might not exist in CLI-accessible format yet
                    // (e.g., created by keyring crate with restrictive ACL).
                    // Try fallback via keyring crate.
                    tracing::debug!("security CLI get failed for id={}, trying keyring fallback", id);
                }
            }

            // Fallback: read via keyring (may trigger one-time keychain dialog for old items)
            let entry = Entry::new(&self.service, &account)?;
            match entry.get_password() {
                Ok(secret) => {
                    tracing::info!("Keychain get via keyring fallback: id={}, len={}", id, secret.len());
                    // Migrate to permissive ACL so the dialog never appears again
                    let _ = mac_keychain::store(&self.service, &account, &secret);
                    return Ok(secret);
                }
                Err(keyring::Error::NoEntry) => {
                    return Err(KeychainError::NotFound(id.to_string()));
                }
                Err(e) => {
                    tracing::error!("Keychain get fallback failed: id={}, error={:?}", id, e);
                    return Err(KeychainError::Keyring(e));
                }
            }
        }

        // Non-biometric path: use keyring crate directly
        tracing::info!("Keychain get: service={}, id={}", self.service, id);
        let username = whoami::username();
        let entry = Entry::new(&self.service, &format!("{}@{}", username, id))?;
        match entry.get_password() {
            Ok(secret) => {
                tracing::info!("Keychain get success: id={}, len={}", id, secret.len());
                Ok(secret)
            }
            Err(keyring::Error::NoEntry) => {
                tracing::warn!("Keychain get: no entry for id={}", id);
                Err(KeychainError::NotFound(id.to_string()))
            }
            Err(e) => {
                tracing::error!("Keychain get failed: id={}, error={:?}", id, e);
                Err(KeychainError::Keyring(e))
            }
        }
    }

    /// Retrieve a secret from the keychain **without** biometric authentication.
    ///
    /// Used by the CLI server where Touch ID cannot display a prompt.
    /// On macOS with biometric mode: reads directly via `security` CLI,
    /// falling back to the `keyring` crate. No Touch ID gate.
    /// On other platforms or non-biometric mode: identical to [`Self::get`].
    pub fn get_without_biometrics(&self, id: &str) -> Result<String, KeychainError> {
        #[cfg(target_os = "macos")]
        if self.use_biometrics {
            let username = whoami::username();
            let account = format!("{}@{}", username, id);

            // Try reading via security CLI (works without dialog for -A items)
            match mac_keychain::get(&self.service, &account) {
                Ok(secret) => {
                    tracing::info!("Keychain get (no bio) via security CLI: id={}, len={}", id, secret.len());
                    return Ok(secret);
                }
                Err(_) => {
                    tracing::debug!("security CLI get failed for id={}, trying keyring fallback", id);
                }
            }

            // Fallback: read via keyring crate
            let entry = Entry::new(&self.service, &account)?;
            match entry.get_password() {
                Ok(secret) => {
                    tracing::info!("Keychain get (no bio) via keyring fallback: id={}, len={}", id, secret.len());
                    return Ok(secret);
                }
                Err(keyring::Error::NoEntry) => {
                    return Err(KeychainError::NotFound(id.to_string()));
                }
                Err(e) => {
                    tracing::error!("Keychain get (no bio) fallback failed: id={}, error={:?}", id, e);
                    return Err(KeychainError::Keyring(e));
                }
            }
        }

        // Non-biometric mode: delegate to normal get()
        self.get(id)
    }

    /// Delete a secret from the keychain.
    ///
    /// No Touch ID prompt — deletion is always allowed.
    pub fn delete(&self, id: &str) -> Result<(), KeychainError> {
        let username = whoami::username();
        let account = format!("{}@{}", username, id);

        #[cfg(target_os = "macos")]
        if self.use_biometrics {
            // Delete via security CLI (no ACL prompt)
            let _ = mac_keychain::delete(&self.service, &account);
            // Also try to delete any keyring-created entry (migration cleanup)
            let entry = Entry::new(&self.service, &account)?;
            let _ = entry.delete_credential();
            return Ok(());
        }

        let entry = Entry::new(&self.service, &account)?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()), // Already deleted
            Err(e) => Err(KeychainError::Keyring(e)),
        }
    }

    /// Check if a secret exists.
    ///
    /// No Touch ID prompt — existence check only.
    pub fn exists(&self, id: &str) -> Result<bool, KeychainError> {
        let username = whoami::username();
        let account = format!("{}@{}", username, id);

        #[cfg(target_os = "macos")]
        if self.use_biometrics {
            // Use security CLI without -w → no ACL prompt
            return Ok(mac_keychain::exists(&self.service, &account));
        }

        let entry = Entry::new(&self.service, &account)?;
        match entry.get_password() {
            Ok(_) => Ok(true),
            Err(keyring::Error::NoEntry) => Ok(false),
            Err(e) => Err(KeychainError::Keyring(e)),
        }
    }

    /// Update an existing secret
    pub fn update(&self, id: &str, new_secret: &str) -> Result<(), KeychainError> {
        // keyring will overwrite existing entry
        self.store(id, new_secret)
    }
}

impl Default for Keychain {
    fn default() -> Self {
        Self::new()
    }
}

/// Helper function to create a keychain entry label
pub fn make_label(host: &str, username: &str) -> String {
    format!("OxideTerm: {}@{}", username, host)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Note: These tests interact with the real system keychain
    // They use a unique service name to avoid conflicts

    #[test]
    #[ignore] // Run manually: cargo test keychain -- --ignored
    fn test_keychain_operations() {
        let keychain = Keychain::with_service("com.oxideterm.test");
        let id = Keychain::generate_id();

        // Store
        keychain.store(&id, "test-secret").unwrap();

        // Get
        let secret = keychain.get(&id).unwrap();
        assert_eq!(secret, "test-secret");

        // Exists
        assert!(keychain.exists(&id).unwrap());

        // Update
        keychain.update(&id, "new-secret").unwrap();
        let secret = keychain.get(&id).unwrap();
        assert_eq!(secret, "new-secret");

        // Delete
        keychain.delete(&id).unwrap();
        assert!(!keychain.exists(&id).unwrap());
    }

    #[test]
    fn test_generate_id() {
        let id1 = Keychain::generate_id();
        let id2 = Keychain::generate_id();

        assert!(id1.starts_with("oxideterm-"));
        assert!(id2.starts_with("oxideterm-"));
        assert_ne!(id1, id2);
    }
}
