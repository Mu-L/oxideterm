// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

//! Known hosts management for SSH host key verification
//!
//! Wraps russh::keys known_hosts functionality with additional features.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;

use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use parking_lot::RwLock;
use russh::keys::{PublicKey, PublicKeyBase64};
use sha2::{Digest, Sha256};
use tracing::{debug, info, warn};

use super::error::SshError;

/// Result of host key verification
#[derive(Debug, Clone, PartialEq)]
pub enum HostKeyVerification {
    /// Key matches known_hosts entry
    Verified,
    /// Host not in known_hosts (first connection)
    Unknown { fingerprint: String },
    /// Key changed from known_hosts entry (potential MITM)
    Changed {
        expected_fingerprint: String,
        actual_fingerprint: String,
    },
}

/// Entry in known_hosts: (key_type, base64_key)
#[derive(Clone, Debug)]
struct HostKeyEntry {
    key_type: String,
    key_data: String,
}

/// Global known hosts store
pub struct KnownHostsStore {
    /// Cache of host -> list of keys (supports multiple key types per host)
    hosts: RwLock<HashMap<String, Vec<HostKeyEntry>>>,
    /// Path to known_hosts file
    path: PathBuf,
}

impl Default for KnownHostsStore {
    fn default() -> Self {
        Self::new()
    }
}

impl KnownHostsStore {
    /// Canonicalize a hostname entry as it appears in known_hosts.
    ///
    /// Examples:
    /// - `github.com` -> `github.com`
    /// - `[server.example.com]:2222` -> `[server.example.com]:2222`
    /// - `[server.example.com]:22` -> `server.example.com`
    fn canonical_host_entry(hostname: &str) -> String {
        let hostname = hostname.trim();
        if let Some(stripped) = hostname.strip_prefix('[') {
            if let Some((host, port_str)) = stripped.split_once("]:") {
                if let Ok(port) = port_str.parse::<u16>() {
                    return Self::make_key(host, port);
                }
            }
        }
        Self::normalize_hostname(hostname)
    }

    /// Create a new known hosts store, loading from default location
    pub fn new() -> Self {
        #[cfg(test)]
        let path = std::env::temp_dir().join(format!(
            "oxideterm-test-known_hosts-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));

        #[cfg(not(test))]
        let path = dirs::home_dir()
            .map(|h| h.join(".ssh").join("known_hosts"))
            .unwrap_or_else(|| PathBuf::from("~/.ssh/known_hosts"));

        let mut store = Self {
            hosts: RwLock::new(HashMap::new()),
            path,
        };

        if let Err(e) = store.load() {
            warn!("Failed to load known_hosts: {}", e);
        }

        store
    }

    /// Create with custom path (for testing)
    pub fn with_path(path: PathBuf) -> Self {
        let mut store = Self {
            hosts: RwLock::new(HashMap::new()),
            path,
        };

        if let Err(e) = store.load() {
            debug!("Known hosts file not found or empty: {}", e);
        }

        store
    }

    /// Load known_hosts file
    fn load(&mut self) -> Result<(), SshError> {
        if !self.path.exists() {
            return Ok(());
        }

        let file = fs::File::open(&self.path).map_err(SshError::IoError)?;

        let reader = BufReader::new(file);
        let mut hosts = self.hosts.write();
        let mut entry_count = 0;

        for line in reader.lines() {
            let line = line.map_err(SshError::IoError)?;
            let line = line.trim();

            // Skip empty lines and comments
            if line.is_empty() || line.starts_with('#') {
                continue;
            }

            // Parse: hostname keytype base64key [comment]
            // Or: hostname,alias keytype base64key [comment]
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() < 3 {
                continue;
            }

            let hostnames = parts[0];
            let key_type = parts[1].to_string();
            let key_data = parts[2].to_string();

            let entry = HostKeyEntry { key_type, key_data };

            // Handle multiple hostnames (comma-separated)
            for hostname in hostnames.split(',') {
                // Handle hashed hostnames (|1|...) - skip for now
                if hostname.starts_with('|') {
                    continue;
                }

                let canonical = Self::canonical_host_entry(hostname);
                hosts.entry(canonical).or_default().push(entry.clone());
                entry_count += 1;
            }
        }

        info!(
            "Loaded {} known host entries ({} unique hosts)",
            entry_count,
            hosts.len()
        );
        Ok(())
    }

    /// Normalize hostname for lookup
    fn normalize_hostname(host: &str) -> String {
        // Remove brackets and port: [host]:port -> host
        let host = host.trim_start_matches('[');
        if let Some(idx) = host.find("]:") {
            host[..idx].to_lowercase()
        } else {
            host.trim_end_matches(']').to_lowercase()
        }
    }

    /// Create lookup key for host:port
    fn make_key(host: &str, port: u16) -> String {
        let host = host.to_lowercase();
        if port == 22 {
            host
        } else {
            format!("[{}]:{}", host, port)
        }
    }

    /// Compute SHA256 fingerprint of public key
    pub fn fingerprint(key: &PublicKey) -> String {
        let key_bytes = key.public_key_bytes();
        let mut hasher = Sha256::new();
        hasher.update(&key_bytes);
        let hash = hasher.finalize();
        format!("SHA256:{}", BASE64.encode(hash).trim_end_matches('='))
    }

    /// Verify a host's public key
    pub fn verify(&self, host: &str, port: u16, key: &PublicKey) -> HostKeyVerification {
        let lookup_key = Self::make_key(host, port);
        let actual_key_b64 = BASE64.encode(key.public_key_bytes());
        let actual_key_type = Self::key_type_name(key);
        let fingerprint = Self::fingerprint(key);

        let hosts = self.hosts.read();

        // Helper to check entries for a given hostname
        let check_entries = |entries: &Vec<HostKeyEntry>| -> Option<HostKeyVerification> {
            let mut expected_fingerprint = None;

            for entry in entries {
                if entry.key_type == actual_key_type {
                    if entry.key_data == actual_key_b64 {
                        debug!(
                            "Host key verified for {} (type: {})",
                            lookup_key, actual_key_type
                        );
                        return Some(HostKeyVerification::Verified);
                    }

                    if expected_fingerprint.is_none() {
                        expected_fingerprint =
                            Some(Self::compute_fingerprint_from_b64(&entry.key_data));
                    }
                }
            }

            if let Some(expected_fingerprint) = expected_fingerprint {
                warn!(
                    "HOST KEY CHANGED for {} (type: {})! Expected {}, got {}",
                    lookup_key, actual_key_type, expected_fingerprint, fingerprint
                );
                return Some(HostKeyVerification::Changed {
                    expected_fingerprint,
                    actual_fingerprint: fingerprint.clone(),
                });
            }

            // No matching key type found - host is known but not for this key type
            None
        };

        // Try exact match first (with port)
        if let Some(entries) = hosts.get(&lookup_key) {
            if let Some(result) = check_entries(entries) {
                return result;
            }
            // Host known but not for this key type - treat as new key type (auto-accept)
            debug!(
                "Host {} known but no {} key stored, treating as new",
                lookup_key, actual_key_type
            );
            return HostKeyVerification::Unknown { fingerprint };
        }

        // Try hostname without port
        let host_only = host.to_lowercase();
        if let Some(entries) = hosts.get(&host_only) {
            if let Some(result) = check_entries(entries) {
                return result;
            }
            // Host known but not for this key type
            debug!(
                "Host {} known but no {} key stored, treating as new",
                host_only, actual_key_type
            );
            return HostKeyVerification::Unknown { fingerprint };
        }

        debug!("Unknown host: {}", lookup_key);
        HostKeyVerification::Unknown { fingerprint }
    }

    /// Compute fingerprint from stored base64 key
    fn compute_fingerprint_from_b64(stored_b64: &str) -> String {
        if let Ok(bytes) = BASE64.decode(stored_b64) {
            let mut hasher = Sha256::new();
            hasher.update(&bytes);
            let hash = hasher.finalize();
            format!("SHA256:{}", BASE64.encode(hash).trim_end_matches('='))
        } else {
            "unknown".to_string()
        }
    }

    /// Add a new host key to known_hosts
    pub fn add_host(&self, host: &str, port: u16, key: &PublicKey) -> Result<(), SshError> {
        let lookup_key = Self::make_key(host, port);
        let key_b64 = BASE64.encode(key.public_key_bytes());
        let key_type = Self::key_type_name(key).to_string();

        // Update in-memory cache
        {
            let mut hosts = self.hosts.write();
            let entry = HostKeyEntry {
                key_type: key_type.clone(),
                key_data: key_b64.clone(),
            };
            hosts.entry(lookup_key.clone()).or_default().push(entry);
        }

        // Append to file
        self.append_to_file(&lookup_key, &key_type, &key_b64)?;

        info!(
            "Added host key for {} (type: {}) to known_hosts",
            lookup_key, key_type
        );
        Ok(())
    }

    /// Get key type name for known_hosts format
    fn key_type_name(key: &PublicKey) -> &'static str {
        match key.algorithm().as_str() {
            "ssh-ed25519" => "ssh-ed25519",
            "ssh-rsa" => "ssh-rsa",
            "ecdsa-sha2-nistp256" => "ecdsa-sha2-nistp256",
            "ecdsa-sha2-nistp384" => "ecdsa-sha2-nistp384",
            "ecdsa-sha2-nistp521" => "ecdsa-sha2-nistp521",
            _ => "ssh-rsa",
        }
    }

    /// Append entry to known_hosts file
    fn append_to_file(&self, host: &str, key_type: &str, key_b64: &str) -> Result<(), SshError> {
        // Ensure .ssh directory exists
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(SshError::IoError)?;
        }

        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(SshError::IoError)?;

        writeln!(file, "{} {} {}", host, key_type, key_b64).map_err(SshError::IoError)?;

        Ok(())
    }

    /// Remove a specific saved host key from known_hosts.
    pub fn remove_host_key(
        &self,
        host: &str,
        port: u16,
        key_type: &str,
        expected_fingerprint: &str,
    ) -> Result<(), SshError> {
        let lookup_key = Self::make_key(host, port);
        let host_only_key = Self::normalize_hostname(host);
        let mut lookup_keys = vec![lookup_key.clone()];
        if host_only_key != lookup_key {
            lookup_keys.push(host_only_key);
        }

        let mut removed_any = false;

        removed_any |= self.rewrite_without_host_key(&lookup_keys, key_type, expected_fingerprint)?;

        {
            let mut hosts = self.hosts.write();
            for candidate_key in &lookup_keys {
                if let Some(entries) = hosts.get_mut(candidate_key) {
                    let before_len = entries.len();
                    entries.retain(|entry| {
                        !(entry.key_type == key_type
                            && Self::compute_fingerprint_from_b64(&entry.key_data)
                                == expected_fingerprint)
                    });
                    let is_empty = entries.is_empty();
                    removed_any |= before_len != entries.len();
                    if is_empty {
                        hosts.remove(candidate_key);
                    }
                }
            }
        }

        if !removed_any {
            return Err(SshError::ConnectionFailed(format!(
                "No saved host key matched {} (type: {}, fingerprint: {})",
                lookup_key, key_type, expected_fingerprint
            )));
        }

        info!(
            "Removed saved host key roots for {} (type: {}, fingerprint: {}) from known_hosts",
            lookup_key, key_type, expected_fingerprint
        );
        Ok(())
    }

    /// Rewrite known_hosts file without the specified host/key match.
    fn rewrite_without_host_key(
        &self,
        remove_hosts: &[String],
        remove_key_type: &str,
        remove_fingerprint: &str,
    ) -> Result<bool, SshError> {
        if !self.path.exists() {
            return Ok(false);
        }

        let content = fs::read_to_string(&self.path).map_err(SshError::IoError)?;
        let remove_hosts: Vec<String> = remove_hosts.iter().map(|host| host.to_lowercase()).collect();
        let mut removed_any = false;

        let filtered: Vec<String> = content
            .lines()
            .filter_map(|line| {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.is_empty() {
                    return Some(line.to_string());
                }
                if parts.len() < 3 {
                    return Some(line.to_string());
                }

                let hostnames = parts[0];
                let key_type = parts[1];
                let key_data = parts[2];
                let fingerprint = Self::compute_fingerprint_from_b64(key_data);

                if key_type != remove_key_type || fingerprint != remove_fingerprint {
                    return Some(line.to_string());
                }

                let kept_hostnames: Vec<&str> = hostnames
                    .split(',')
                    .filter(|h| {
                        let canonical = Self::canonical_host_entry(h);
                        !remove_hosts.iter().any(|remove_host| canonical == *remove_host)
                    })
                    .collect();

                if kept_hostnames.len() == hostnames.split(',').count() {
                    return Some(line.to_string());
                }

                removed_any = true;

                if kept_hostnames.is_empty() {
                    return None;
                }

                let mut rebuilt = vec![kept_hostnames.join(","), key_type.to_string(), key_data.to_string()];
                if parts.len() > 3 {
                    rebuilt.extend(parts[3..].iter().map(|part| (*part).to_string()));
                }

                Some(rebuilt.join(" "))
            })
            .collect();

        fs::write(&self.path, filtered.join("\n") + "\n").map_err(SshError::IoError)?;

        Ok(removed_any)
    }
}

/// Global singleton for known hosts
static KNOWN_HOSTS: std::sync::OnceLock<KnownHostsStore> = std::sync::OnceLock::new();

/// Get the global known hosts store
pub fn get_known_hosts() -> &'static KnownHostsStore {
    KNOWN_HOSTS.get_or_init(KnownHostsStore::new)
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::keys::parse_public_key_base64;
    use tempfile::tempdir;

    fn sample_public_key() -> PublicKey {
        parse_public_key_base64(
            "AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ",
        )
        .unwrap()
    }

    fn alternate_public_key() -> PublicKey {
        parse_public_key_base64(
            "AAAAC3NzaC1lZDI1NTE5AAAAIA6rWI3G1sz07DnfFlrouTcysQlj2P+jpNSOEWD9OJ3X",
        )
        .unwrap()
    }

    #[test]
    fn test_normalize_hostname() {
        assert_eq!(
            KnownHostsStore::normalize_hostname("github.com"),
            "github.com"
        );
        assert_eq!(
            KnownHostsStore::normalize_hostname("[github.com]:22"),
            "github.com"
        );
        assert_eq!(
            KnownHostsStore::normalize_hostname("[server.example.com]:2222"),
            "server.example.com"
        );
    }

    #[test]
    fn test_make_key() {
        assert_eq!(KnownHostsStore::make_key("github.com", 22), "github.com");
        assert_eq!(
            KnownHostsStore::make_key("server.com", 2222),
            "[server.com]:2222"
        );
    }

    #[test]
    fn test_normalize_hostname_plain() {
        assert_eq!(
            KnownHostsStore::normalize_hostname("GITHUB.COM"),
            "github.com"
        );
    }

    #[test]
    fn test_normalize_hostname_trailing_bracket() {
        assert_eq!(KnownHostsStore::normalize_hostname("[host]"), "host");
    }

    #[test]
    fn test_make_key_case_insensitive() {
        assert_eq!(KnownHostsStore::make_key("GitHub.COM", 22), "github.com");
        assert_eq!(
            KnownHostsStore::make_key("Server.COM", 2222),
            "[server.com]:2222"
        );
    }

    #[test]
    fn test_compute_fingerprint_from_b64_valid() {
        // A known base64 value
        let result = KnownHostsStore::compute_fingerprint_from_b64("dGVzdA==");
        assert!(result.starts_with("SHA256:"));
    }

    #[test]
    fn test_compute_fingerprint_from_b64_invalid() {
        let result = KnownHostsStore::compute_fingerprint_from_b64("!!!invalid!!!");
        assert_eq!(result, "unknown");
    }

    #[test]
    fn test_make_key_port_22() {
        // Port 22 should produce bare hostname
        let key = KnownHostsStore::make_key("example.com", 22);
        assert!(!key.contains('['));
        assert!(!key.contains(':'));
    }

    #[test]
    fn test_make_key_non_standard_port() {
        let key = KnownHostsStore::make_key("example.com", 443);
        assert_eq!(key, "[example.com]:443");
    }

    #[test]
    fn test_canonical_host_entry_preserves_non_standard_port() {
        assert_eq!(
            KnownHostsStore::canonical_host_entry("[example.com]:2222"),
            "[example.com]:2222"
        );
        assert_eq!(
            KnownHostsStore::canonical_host_entry("[example.com]:22"),
            "example.com"
        );
    }

    #[test]
    fn test_with_path_missing_file_starts_empty() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("missing_known_hosts");
        let store = KnownHostsStore::with_path(path);
        assert!(store.hosts.read().is_empty());
    }

    #[test]
    fn test_load_preserves_non_standard_port_entries() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        fs::write(
            &path,
            "[example.com]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILM+rvN+ot98qgEN796jTiQfZfG1KaT0PtFDJ/XFSqti\n",
        )
        .unwrap();

        let store = KnownHostsStore::with_path(path);
        assert!(store.hosts.read().contains_key("[example.com]:2222"));
    }

    #[test]
    fn test_load_skips_comments_and_hashed_hosts() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        fs::write(
            &path,
            "# comment\n|1|hashed|entry ssh-ed25519 AAAA\nexample.com,alias.example.com ssh-rsa AAAA\n",
        )
        .unwrap();

        let store = KnownHostsStore::with_path(path);
        let hosts = store.hosts.read();
        assert!(hosts.contains_key("example.com"));
        assert!(hosts.contains_key("alias.example.com"));
        assert!(!hosts.contains_key("|1|hashed|entry"));
    }

    #[test]
    fn test_verify_distinguishes_non_standard_port_entries() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let store = KnownHostsStore::with_path(path);
        let key = sample_public_key();

        store.add_host("example.com", 2222, &key).unwrap();

        assert_eq!(
            store.verify("example.com", 2222, &key),
            HostKeyVerification::Verified
        );
        assert!(matches!(
            store.verify("example.com", 22, &key),
            HostKeyVerification::Unknown { .. }
        ));
    }

    #[test]
    fn test_remove_host_non_standard_port_rewrites_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let key_data = BASE64.encode(sample_public_key().public_key_bytes());
        let fingerprint = KnownHostsStore::compute_fingerprint_from_b64(&key_data);
        fs::write(
            &path,
            format!(
                "[example.com]:2222 ssh-ed25519 {}\nother.example.com ssh-rsa AAAA\n",
                key_data
            ),
        )
        .unwrap();

        let store = KnownHostsStore::with_path(path.clone());
        store
            .remove_host_key("example.com", 2222, "ssh-ed25519", &fingerprint)
            .unwrap();

        let content = fs::read_to_string(path).unwrap();
        assert!(!content.contains("[example.com]:2222"));
        assert!(content.contains("other.example.com"));
    }

    #[test]
    fn test_remove_host_only_deletes_exact_host_port_entry() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let exact_key_data = BASE64.encode(sample_public_key().public_key_bytes());
        let fallback_key_data = BASE64.encode(alternate_public_key().public_key_bytes());
        let fingerprint = KnownHostsStore::compute_fingerprint_from_b64(&exact_key_data);
        fs::write(
            &path,
            format!(
                "example.com ssh-ed25519 {}\n[example.com]:2222 ssh-ed25519 {}\n",
                fallback_key_data, exact_key_data
            ),
        )
        .unwrap();

        let store = KnownHostsStore::with_path(path.clone());
        store
            .remove_host_key("example.com", 2222, "ssh-ed25519", &fingerprint)
            .unwrap();

        let content = fs::read_to_string(path).unwrap();
        assert!(content.contains(&format!("example.com ssh-ed25519 {}", fallback_key_data)));
        assert!(!content.contains(&format!("[example.com]:2222 ssh-ed25519 {}", exact_key_data)));
    }

    #[test]
    fn test_remove_host_key_preserves_aliases_on_same_line() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let key_data = BASE64.encode(sample_public_key().public_key_bytes());
        let fingerprint = KnownHostsStore::compute_fingerprint_from_b64(&key_data);
        fs::write(
            &path,
            format!(
                "example.com,alias.example.com ssh-ed25519 {} keep-me\n",
                key_data
            ),
        )
        .unwrap();

        let store = KnownHostsStore::with_path(path.clone());
        store
            .remove_host_key("example.com", 22, "ssh-ed25519", &fingerprint)
            .unwrap();

        let content = fs::read_to_string(path).unwrap();
        assert!(!content.contains("example.com,"));
        assert!(content.contains(&format!("alias.example.com ssh-ed25519 {} keep-me", key_data)));
    }

    #[test]
    fn test_remove_host_key_preserves_other_saved_keys_for_same_host() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let first = BASE64.encode(sample_public_key().public_key_bytes());
        let second = BASE64.encode(alternate_public_key().public_key_bytes());
        let first_fingerprint = KnownHostsStore::compute_fingerprint_from_b64(&first);
        fs::write(
            &path,
            format!(
                "example.com ssh-ed25519 {}\nexample.com ssh-ed25519 {}\n",
                first, second
            ),
        )
        .unwrap();

        let store = KnownHostsStore::with_path(path.clone());
        store
            .remove_host_key("example.com", 22, "ssh-ed25519", &first_fingerprint)
            .unwrap();

        let content = fs::read_to_string(path).unwrap();
        assert!(!content.contains(&first));
        assert!(content.contains(&second));
    }

    #[test]
    fn test_remove_host_key_can_remove_host_only_fallback_for_non_standard_port() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let key_data = BASE64.encode(sample_public_key().public_key_bytes());
        let fingerprint = KnownHostsStore::compute_fingerprint_from_b64(&key_data);
        fs::write(&path, format!("example.com ssh-ed25519 {}\n", key_data)).unwrap();

        let store = KnownHostsStore::with_path(path.clone());
        store
            .remove_host_key("example.com", 2222, "ssh-ed25519", &fingerprint)
            .unwrap();

        let content = fs::read_to_string(path).unwrap();
        assert!(!content.contains("example.com ssh-ed25519"));
    }

    #[test]
    fn test_remove_host_key_clears_exact_and_fallback_entries_for_same_saved_key() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let key_data = BASE64.encode(sample_public_key().public_key_bytes());
        let fingerprint = KnownHostsStore::compute_fingerprint_from_b64(&key_data);
        fs::write(
            &path,
            format!(
                "example.com ssh-ed25519 {}\n[example.com]:2222 ssh-ed25519 {}\n",
                key_data, key_data
            ),
        )
        .unwrap();

        let store = KnownHostsStore::with_path(path.clone());
        store
            .remove_host_key("example.com", 2222, "ssh-ed25519", &fingerprint)
            .unwrap();

        let content = fs::read_to_string(path).unwrap();
        assert!(!content.contains(&key_data));
    }

    #[test]
    fn test_remove_host_key_errors_when_no_match_exists() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        fs::write(&path, "other.example.com ssh-ed25519 AAAA\n").unwrap();

        let store = KnownHostsStore::with_path(path);
        let error = store
            .remove_host_key("example.com", 22, "ssh-ed25519", "SHA256:missing")
            .unwrap_err();

        assert!(matches!(error, SshError::ConnectionFailed(_)));
    }

    #[test]
    fn test_load_skips_malformed_lines() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        fs::write(
            &path,
            format!(
                "badline\nmissing-key ssh-ed25519\nvalid.example.com ssh-ed25519 {}\n",
                BASE64.encode(sample_public_key().public_key_bytes())
            ),
        )
        .unwrap();

        let store = KnownHostsStore::with_path(path);
        let hosts = store.hosts.read();
        assert_eq!(hosts.len(), 1);
        assert!(hosts.contains_key("valid.example.com"));
    }

    #[test]
    fn test_verify_prefers_exact_match_when_duplicate_host_entries_exist() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let first = BASE64.encode(alternate_public_key().public_key_bytes());
        let second = BASE64.encode(sample_public_key().public_key_bytes());
        fs::write(
            &path,
            format!(
                "example.com ssh-ed25519 {}\nexample.com ssh-ed25519 {}\n",
                first, second
            ),
        )
        .unwrap();

        let store = KnownHostsStore::with_path(path);
        assert_eq!(
            store.verify("example.com", 22, &sample_public_key()),
            HostKeyVerification::Verified
        );
    }

    #[test]
    fn test_verify_alias_from_multi_host_line() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let key_b64 = BASE64.encode(sample_public_key().public_key_bytes());
        fs::write(
            &path,
            format!("example.com,alias.example.com ssh-ed25519 {}\n", key_b64),
        )
        .unwrap();

        let store = KnownHostsStore::with_path(path);
        assert_eq!(
            store.verify("alias.example.com", 22, &sample_public_key()),
            HostKeyVerification::Verified
        );
    }

    #[test]
    fn test_hashed_host_entries_are_not_used_for_verification() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let key_b64 = BASE64.encode(sample_public_key().public_key_bytes());
        fs::write(&path, format!("|1|salt|hash ssh-ed25519 {}\n", key_b64)).unwrap();

        let store = KnownHostsStore::with_path(path);
        assert!(matches!(
            store.verify("example.com", 22, &sample_public_key()),
            HostKeyVerification::Unknown { .. }
        ));
    }
}
