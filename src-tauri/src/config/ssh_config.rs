// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

//! SSH Config Parser (Enhanced for HPC)
//!
//! Parses ~/.ssh/config to import existing SSH hosts.
//! Supports:
//! - Basic: Host, HostName, User, Port, IdentityFile
//! - ProxyJump: Multi-hop jump hosts
//! - Port Forwarding: LocalForward, RemoteForward, DynamicForward

use glob::{MatchOptions, glob};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use tokio::fs;
use tracing::warn;

/// Port forwarding rule
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortForwardRule {
    /// Local bind address (default: localhost)
    pub bind_address: String,
    /// Local port
    pub local_port: u16,
    /// Remote host
    pub remote_host: String,
    /// Remote port
    pub remote_port: u16,
}

impl PortForwardRule {
    /// Parse from SSH config format: "[bind_address:]port host:hostport"
    pub fn parse(value: &str) -> Option<Self> {
        let parts: Vec<&str> = value.split_whitespace().collect();
        if parts.len() != 2 {
            return None;
        }

        // Parse local part: [bind_address:]port
        let (bind_address, local_port) = if parts[0].contains(':') {
            let local_parts: Vec<&str> = parts[0].rsplitn(2, ':').collect();
            if local_parts.len() == 2 {
                (local_parts[1].to_string(), local_parts[0].parse().ok()?)
            } else {
                return None;
            }
        } else {
            ("localhost".to_string(), parts[0].parse().ok()?)
        };

        // Parse remote part: host:hostport
        let remote_parts: Vec<&str> = parts[1].rsplitn(2, ':').collect();
        if remote_parts.len() != 2 {
            return None;
        }

        Some(PortForwardRule {
            bind_address,
            local_port,
            remote_host: remote_parts[1].to_string(),
            remote_port: remote_parts[0].parse().ok()?,
        })
    }
}

/// Proxy jump host (for ProxyJump directive)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyJumpHost {
    /// Username (optional, inherits from main config if not specified)
    pub user: Option<String>,
    /// Hostname
    pub host: String,
    /// Port (default: 22)
    pub port: u16,

    /// Whether the port was explicitly specified in the ProxyJump string.
    #[serde(skip)]
    pub port_specified: bool,
}

impl ProxyJumpHost {
    /// Parse from SSH config format: "[user@]host[:port]"
    pub fn parse(value: &str) -> Option<Self> {
        let (user, host_port) = if value.contains('@') {
            let parts: Vec<&str> = value.splitn(2, '@').collect();
            (Some(parts[0].to_string()), parts[1])
        } else {
            (None, value)
        };

        let (host, port) = if host_port.contains(':') {
            let parts: Vec<&str> = host_port.rsplitn(2, ':').collect();
            (parts[1].to_string(), parts[0].parse().unwrap_or(22))
        } else {
            (host_port.to_string(), 22)
        };

        Some(ProxyJumpHost {
            user,
            host,
            port,
            port_specified: host_port.contains(':'),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResolvedProxyJumpHost {
    pub alias: Option<String>,
    pub user: Option<String>,
    pub host: String,
    pub port: u16,
    pub identity_file: Option<String>,
    pub certificate_file: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResolvedSshConfigHost {
    pub alias: String,
    pub host: String,
    pub user: Option<String>,
    pub port: u16,
    pub identity_file: Option<String>,
    pub certificate_file: Option<String>,
    #[serde(default)]
    pub proxy_chain: Vec<ResolvedProxyJumpHost>,
}

/// A parsed SSH config host entry (Enhanced)
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SshConfigHost {
    /// Host alias (the pattern after "Host")
    pub alias: String,
    /// Actual hostname (HostName directive)
    pub hostname: Option<String>,
    /// Username (User directive)
    pub user: Option<String>,
    /// Port number (Port directive)
    pub port: Option<u16>,
    /// Identity file path (IdentityFile directive)
    pub identity_file: Option<String>,

    /// Certificate file path (CertificateFile directive)
    pub certificate_file: Option<String>,

    /// ProxyJump chain (parsed from ProxyJump directive)
    #[serde(default)]
    pub proxy_jump: Vec<ProxyJumpHost>,

    /// ProxyCommand (alternative to ProxyJump)
    pub proxy_command: Option<String>,

    /// Local port forwards
    #[serde(default)]
    pub local_forwards: Vec<PortForwardRule>,

    /// Remote port forwards
    #[serde(default)]
    pub remote_forwards: Vec<PortForwardRule>,

    /// Dynamic forward port (SOCKS proxy)
    pub dynamic_forward: Option<u16>,

    /// Other directives we don't directly use
    #[serde(default)]
    pub other: HashMap<String, String>,
}

impl SshConfigHost {
    /// Get the effective hostname (hostname or alias)
    pub fn effective_hostname(&self) -> &str {
        self.hostname.as_deref().unwrap_or(&self.alias)
    }

    /// Get effective port (port or 22)
    pub fn effective_port(&self) -> u16 {
        self.port.unwrap_or(22)
    }

    /// Check if this is a wildcard pattern
    pub fn is_wildcard(&self) -> bool {
        self.alias.contains('*') || self.alias.contains('?')
    }

    /// Check if this host requires a proxy jump
    pub fn has_proxy_jump(&self) -> bool {
        !self.proxy_jump.is_empty()
    }

    /// Check if this host has any port forwards configured
    pub fn has_port_forwards(&self) -> bool {
        !self.local_forwards.is_empty()
            || !self.remote_forwards.is_empty()
            || self.dynamic_forward.is_some()
    }

    /// Get proxy jump chain description (for UI display)
    pub fn proxy_jump_description(&self) -> Option<String> {
        if self.proxy_jump.is_empty() {
            return None;
        }

        let hops: Vec<String> = self
            .proxy_jump
            .iter()
            .map(|hop| {
                if let Some(ref user) = hop.user {
                    format!("{}@{}:{}", user, hop.host, hop.port)
                } else {
                    format!("{}:{}", hop.host, hop.port)
                }
            })
            .collect();

        Some(hops.join(" → "))
    }
}

/// SSH config parser errors
#[derive(Debug, thiserror::Error)]
pub enum SshConfigError {
    #[error("Failed to determine home directory")]
    NoHomeDir,

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Parse error at line {line}: {message}")]
    Parse { line: usize, message: String },
}

/// Get default SSH config path
pub fn default_ssh_config_path() -> Result<PathBuf, SshConfigError> {
    dirs::home_dir()
        .map(|home| home.join(".ssh").join("config"))
        .ok_or(SshConfigError::NoHomeDir)
}

fn parse_key_value(line: &str) -> Option<(&str, &str)> {
    if let Some(eq_pos) = line.find('=') {
        let key = line[..eq_pos].trim();
        let value = line[eq_pos + 1..].trim();
        Some((key, value))
    } else {
        let parts: Vec<&str> = line.splitn(2, char::is_whitespace).collect();
        if parts.len() < 2 {
            None
        } else {
            Some((parts[0], parts[1].trim()))
        }
    }
}

fn parse_include_tokens(value: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut chars = value.chars().peekable();

    while let Some(ch) = chars.next() {
        if let Some(active_quote) = quote {
            if ch == active_quote {
                quote = None;
            } else if ch == '\\' {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            } else {
                current.push(ch);
            }
            continue;
        }

        match ch {
            '\'' | '"' => quote = Some(ch),
            ch if ch.is_whitespace() => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            '\\' => {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            _ => current.push(ch),
        }
    }

    if !current.is_empty() {
        tokens.push(current);
    }

    tokens
}

fn has_glob_magic(value: &str) -> bool {
    value.contains('*') || value.contains('?') || value.contains('[')
}

fn expand_include_token(base_dir: &Path, token: &str) -> Result<Vec<PathBuf>, SshConfigError> {
    let expanded = crate::path_utils::expand_tilde(token);
    let pattern_path = PathBuf::from(expanded);
    let resolved = if pattern_path.is_absolute() {
        pattern_path
    } else {
        base_dir.join(pattern_path)
    };

    if has_glob_magic(&resolved.to_string_lossy()) {
        let mut matches = Vec::new();
        for entry in glob(&resolved.to_string_lossy()).map_err(|error| SshConfigError::Parse {
            line: 0,
            message: format!("Invalid Include glob '{}': {}", token, error),
        })? {
            match entry {
                Ok(path) => matches.push(path),
                Err(error) => {
                    return Err(SshConfigError::Parse {
                        line: 0,
                        message: format!("Failed to expand Include '{}': {}", token, error),
                    });
                }
            }
        }
        matches.sort();
        Ok(matches)
    } else if resolved.exists() {
        Ok(vec![resolved])
    } else {
        Ok(Vec::new())
    }
}

fn read_ssh_config_with_includes_internal(
    path: &Path,
    include_stack: &mut HashSet<PathBuf>,
) -> Result<String, SshConfigError> {
    let visit_key = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    if !include_stack.insert(visit_key.clone()) {
        warn!(path = %visit_key.display(), "Skipping recursive SSH config Include");
        return Ok(String::new());
    }

    let result = (|| {
        let content = std::fs::read_to_string(path)?;
        let base_dir = path.parent().unwrap_or_else(|| Path::new("."));
        let mut expanded = String::new();

        for raw_line in content.lines() {
            let line = raw_line.trim();
            if line.is_empty() || line.starts_with('#') {
                expanded.push_str(raw_line);
                expanded.push('\n');
                continue;
            }

            let Some((key, value)) = parse_key_value(line) else {
                expanded.push_str(raw_line);
                expanded.push('\n');
                continue;
            };

            if key.eq_ignore_ascii_case("include") {
                for token in parse_include_tokens(value) {
                    for include_path in expand_include_token(base_dir, &token)? {
                        let include_content = match std::fs::metadata(&include_path) {
                            Ok(metadata) if metadata.is_file() => {
                                read_ssh_config_with_includes_internal(
                                    &include_path,
                                    include_stack,
                                )?
                            }
                            Ok(_) => continue,
                            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                                continue;
                            }
                            Err(error) => return Err(SshConfigError::Io(error)),
                        };
                        expanded.push_str(&include_content);
                        if !include_content.ends_with('\n') {
                            expanded.push('\n');
                        }
                    }
                }
                continue;
            }

            expanded.push_str(raw_line);
            expanded.push('\n');
        }

        Ok(expanded)
    })();

    include_stack.remove(&visit_key);
    result
}

fn read_ssh_config_with_includes(path: &Path) -> Result<String, SshConfigError> {
    let mut include_stack = HashSet::new();
    read_ssh_config_with_includes_internal(path, &mut include_stack)
}

fn host_pattern_matches(pattern: &str, alias: &str) -> bool {
    let options = MatchOptions {
        case_sensitive: false,
        require_literal_separator: false,
        require_literal_leading_dot: false,
    };

    glob::Pattern::new(pattern)
        .map(|compiled| compiled.matches_with(alias, options))
        .unwrap_or_else(|_| pattern.eq_ignore_ascii_case(alias))
}

fn host_block_matches(patterns: &[String], alias: &str) -> bool {
    let mut matched = false;

    for pattern in patterns {
        let (negated, value) = if let Some(stripped) = pattern.strip_prefix('!') {
            (true, stripped)
        } else {
            (false, pattern.as_str())
        };

        if host_pattern_matches(value, alias) {
            if negated {
                return false;
            }
            matched = true;
        }
    }

    matched
}

fn is_explicit_host_selector(pattern: &str) -> bool {
    !pattern.starts_with('!') && pattern != "*"
}

fn explicit_host_selector_matches(pattern: &str, alias: &str) -> bool {
    is_explicit_host_selector(pattern) && host_pattern_matches(pattern, alias)
}

#[derive(Debug, Clone, Default)]
struct ResolveAccumulator {
    hostname: Option<String>,
    user: Option<String>,
    port: Option<u16>,
    identity_file: Option<String>,
    certificate_file: Option<String>,
    proxy_jump_seen: bool,
    proxy_jump: Vec<ProxyJumpHost>,
}

fn resolve_ssh_config_alias_content_internal(
    content: &str,
    alias: &str,
    require_explicit_match: bool,
) -> Result<Option<ResolveAccumulator>, SshConfigError> {
    let mut accumulator = ResolveAccumulator::default();
    let mut current_patterns: Option<Vec<String>> = None;
    let mut matched_specific_host = false;
    let mut matched_any_block = false;
    let mut in_match_block = false;

    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let Some((key, value)) = parse_key_value(line) else {
            continue;
        };

        if key.eq_ignore_ascii_case("host") {
            in_match_block = false;
            current_patterns = Some(
                value
                    .split_whitespace()
                    .map(|part| part.to_string())
                    .collect(),
            );
            continue;
        }

        if key.eq_ignore_ascii_case("match") {
            in_match_block = true;
            current_patterns = None;
            continue;
        }

        if in_match_block {
            continue;
        }

        let block_matches = match &current_patterns {
            Some(patterns) => host_block_matches(patterns, alias),
            None => true,
        };

        if !block_matches {
            continue;
        }

        matched_any_block = true;
        if let Some(patterns) = &current_patterns {
            matched_specific_host |= patterns
                .iter()
                .any(|pattern| explicit_host_selector_matches(pattern, alias));
        }

        match key.to_ascii_lowercase().as_str() {
            "hostname" if accumulator.hostname.is_none() => {
                accumulator.hostname = Some(value.to_string());
            }
            "user" if accumulator.user.is_none() => {
                accumulator.user = Some(value.to_string());
            }
            "port" if accumulator.port.is_none() => {
                accumulator.port = value.parse().ok();
            }
            "identityfile" if accumulator.identity_file.is_none() => {
                accumulator.identity_file = Some(crate::path_utils::expand_tilde(value));
            }
            "certificatefile" if accumulator.certificate_file.is_none() => {
                accumulator.certificate_file = Some(crate::path_utils::expand_tilde(value));
            }
            "proxyjump" if !accumulator.proxy_jump_seen => {
                accumulator.proxy_jump_seen = true;
                if !value.eq_ignore_ascii_case("none") {
                    for jump in value.split(',') {
                        if let Some(proxy_host) = ProxyJumpHost::parse(jump.trim()) {
                            accumulator.proxy_jump.push(proxy_host);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    if (require_explicit_match && matched_specific_host)
        || (!require_explicit_match && matched_any_block)
    {
        Ok(Some(accumulator))
    } else {
        Ok(None)
    }
}

fn resolve_ssh_config_alias_content(
    content: &str,
    alias: &str,
) -> Result<Option<ResolveAccumulator>, SshConfigError> {
    resolve_ssh_config_alias_content_internal(content, alias, true)
}

fn resolve_ssh_config_defaults_content(
    content: &str,
    alias: &str,
) -> Result<Option<ResolveAccumulator>, SshConfigError> {
    resolve_ssh_config_alias_content_internal(content, alias, false)
}

fn resolve_proxy_chain(
    content: &str,
    proxy_jump: &[ProxyJumpHost],
    stack: &mut Vec<String>,
) -> Result<Vec<ResolvedProxyJumpHost>, SshConfigError> {
    let mut resolved_chain = Vec::new();

    for hop in proxy_jump {
        if stack
            .iter()
            .any(|entry| entry.eq_ignore_ascii_case(&hop.host))
        {
            return Err(SshConfigError::Parse {
                line: 0,
                message: format!(
                    "Detected cyclic SSH alias reference involving '{}'",
                    hop.host
                ),
            });
        }

        if let Some(resolved_alias) = resolve_ssh_config_alias_content(content, &hop.host)? {
            stack.push(hop.host.clone());
            let nested_chain = resolve_proxy_chain(content, &resolved_alias.proxy_jump, stack)?;
            stack.pop();

            resolved_chain.extend(nested_chain);
            resolved_chain.push(ResolvedProxyJumpHost {
                alias: Some(hop.host.clone()),
                user: hop
                    .user
                    .clone()
                    .or(resolved_alias.user.clone())
                    .or_else(|| Some(whoami::username())),
                host: resolved_alias.hostname.unwrap_or_else(|| hop.host.clone()),
                port: if hop.port_specified {
                    hop.port
                } else {
                    resolved_alias.port.unwrap_or(hop.port)
                },
                identity_file: resolved_alias.identity_file.clone(),
                certificate_file: resolved_alias.certificate_file.clone(),
            });
        } else {
            let defaults = resolve_ssh_config_defaults_content(content, &hop.host)?;
            resolved_chain.push(ResolvedProxyJumpHost {
                alias: None,
                user: hop
                    .user
                    .clone()
                    .or_else(|| defaults.as_ref().and_then(|entry| entry.user.clone()))
                    .or_else(|| Some(whoami::username())),
                host: defaults
                    .as_ref()
                    .and_then(|entry| entry.hostname.clone())
                    .unwrap_or_else(|| hop.host.clone()),
                port: if hop.port_specified {
                    hop.port
                } else {
                    defaults
                        .as_ref()
                        .and_then(|entry| entry.port)
                        .unwrap_or(hop.port)
                },
                identity_file: defaults
                    .as_ref()
                    .and_then(|entry| entry.identity_file.clone()),
                certificate_file: defaults
                    .as_ref()
                    .and_then(|entry| entry.certificate_file.clone()),
            });
        }
    }

    Ok(resolved_chain)
}

pub fn resolve_ssh_config_host_content(
    content: &str,
    alias: &str,
) -> Result<Option<ResolvedSshConfigHost>, SshConfigError> {
    let Some(resolved) = resolve_ssh_config_alias_content(content, alias)? else {
        return Ok(None);
    };

    let mut stack = vec![alias.to_string()];
    let proxy_chain = resolve_proxy_chain(content, &resolved.proxy_jump, &mut stack)?;

    Ok(Some(ResolvedSshConfigHost {
        alias: alias.to_string(),
        host: resolved.hostname.unwrap_or_else(|| alias.to_string()),
        user: resolved.user,
        port: resolved.port.unwrap_or(22),
        identity_file: resolved.identity_file,
        certificate_file: resolved.certificate_file,
        proxy_chain,
    }))
}

pub async fn load_ssh_config_content(
    path: Option<PathBuf>,
) -> Result<Option<String>, SshConfigError> {
    let path = match path {
        Some(path) => path,
        None => default_ssh_config_path()?,
    };

    match fs::metadata(&path).await {
        Ok(metadata) if metadata.is_file() => read_ssh_config_with_includes(&path).map(Some),
        Ok(_) => Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(SshConfigError::Io(error)),
    }
}

pub async fn resolve_ssh_config_host(
    alias: &str,
    path: Option<PathBuf>,
) -> Result<Option<ResolvedSshConfigHost>, SshConfigError> {
    let Some(content) = load_ssh_config_content(path).await? else {
        return Ok(None);
    };

    resolve_ssh_config_host_content(&content, alias)
}

/// Parse SSH config file
pub async fn parse_ssh_config(path: Option<PathBuf>) -> Result<Vec<SshConfigHost>, SshConfigError> {
    let path = match path {
        Some(p) => p,
        None => default_ssh_config_path()?,
    };

    let content = match fs::metadata(&path).await {
        Ok(metadata) if metadata.is_file() => read_ssh_config_with_includes(&path)?,
        Ok(_) => return Ok(Vec::new()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Vec::new());
        }
        Err(e) => return Err(SshConfigError::Io(e)),
    };

    parse_ssh_config_content(&content)
}

/// Parse SSH config content string
pub fn parse_ssh_config_content(content: &str) -> Result<Vec<SshConfigHost>, SshConfigError> {
    let mut hosts = Vec::new();
    let mut current_hosts: Vec<SshConfigHost> = Vec::new();
    let mut in_match_block = false;

    let flush_current_hosts =
        |hosts: &mut Vec<SshConfigHost>, current_hosts: &mut Vec<SshConfigHost>| {
            hosts.extend(current_hosts.drain(..).filter(|host| !host.is_wildcard()));
        };

    for line in content.lines() {
        let line = line.trim();

        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let Some((key, value)) = parse_key_value(line) else {
            continue;
        };

        let key_lower = key.to_lowercase();

        if key_lower == "host" {
            flush_current_hosts(&mut hosts, &mut current_hosts);
            in_match_block = false;

            for alias in value.split_whitespace() {
                if !alias.contains('*') && !alias.contains('?') {
                    current_hosts.push(SshConfigHost {
                        alias: alias.to_string(),
                        ..Default::default()
                    });
                }
            }
            continue;
        }

        if key_lower == "match" {
            flush_current_hosts(&mut hosts, &mut current_hosts);
            in_match_block = true;
            continue;
        }

        if in_match_block || current_hosts.is_empty() {
            continue;
        }

        for host in &mut current_hosts {
            match key_lower.as_str() {
                "hostname" => host.hostname = Some(value.to_string()),
                "user" => host.user = Some(value.to_string()),
                "port" => {
                    host.port = value.parse().ok();
                }
                "identityfile" => {
                    host.identity_file = Some(crate::path_utils::expand_tilde(value));
                }
                "certificatefile" => {
                    host.certificate_file = Some(crate::path_utils::expand_tilde(value));
                }
                "proxyjump" => {
                    if value.to_lowercase() != "none" {
                        for jump in value.split(',') {
                            if let Some(proxy_host) = ProxyJumpHost::parse(jump.trim()) {
                                host.proxy_jump.push(proxy_host);
                            }
                        }
                    }
                }
                "proxycommand" => {
                    if value.to_lowercase() != "none" {
                        host.proxy_command = Some(value.to_string());
                        warn!(
                            "ProxyCommand is not supported by OxideTerm, use ProxyJump instead. \
                             Host '{}' has ProxyCommand: {}",
                            host.alias, value
                        );
                    }
                }
                "localforward" => {
                    if let Some(rule) = PortForwardRule::parse(value) {
                        host.local_forwards.push(rule);
                    }
                }
                "remoteforward" => {
                    if let Some(rule) = PortForwardRule::parse(value) {
                        host.remote_forwards.push(rule);
                    }
                }
                "dynamicforward" => {
                    let port_str = if value.contains(':') {
                        value.rsplit(':').next().unwrap_or(value)
                    } else {
                        value
                    };
                    host.dynamic_forward = port_str.parse().ok();
                }
                _ => {}
            }
        }
    }

    flush_current_hosts(&mut hosts, &mut current_hosts);

    Ok(hosts)
}

/// Filter hosts suitable for import (non-wildcard, has hostname or is valid)
pub fn filter_importable_hosts(hosts: Vec<SshConfigHost>) -> Vec<SshConfigHost> {
    hosts.into_iter().filter(|h| !h.is_wildcard()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_basic() {
        let content = r#"
# Comment
Host myserver
    HostName example.com
    User admin
    Port 2222
    IdentityFile ~/.ssh/id_rsa

Host otherserver
    HostName other.com
    User root
"#;

        let hosts = parse_ssh_config_content(content).unwrap();
        assert_eq!(hosts.len(), 2);

        assert_eq!(hosts[0].alias, "myserver");
        assert_eq!(hosts[0].hostname, Some("example.com".to_string()));
        assert_eq!(hosts[0].user, Some("admin".to_string()));
        assert_eq!(hosts[0].port, Some(2222));
        assert!(hosts[0].identity_file.is_some());

        assert_eq!(hosts[1].alias, "otherserver");
        assert_eq!(hosts[1].effective_port(), 22);
    }

    #[test]
    fn test_skip_wildcards() {
        let content = r#"
Host *
    ServerAliveInterval 60
    
Host dev-*
    User developer
    
Host prod
    HostName prod.example.com
"#;

        let hosts = parse_ssh_config_content(content).unwrap();
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].alias, "prod");
    }

    #[test]
    fn test_effective_values() {
        let host = SshConfigHost {
            alias: "myhost".to_string(),
            hostname: None,
            port: None,
            ..Default::default()
        };

        assert_eq!(host.effective_hostname(), "myhost");
        assert_eq!(host.effective_port(), 22);
    }

    #[test]
    fn test_parse_proxy_jump() {
        let content = r#"
Host hpc
    HostName login.hpc.edu.cn
    User zhangsan
    ProxyJump bastion

Host bastion
    HostName jump.school.edu.cn
    User zhangsan
    IdentityFile ~/.ssh/id_ed25519
"#;

        let hosts = parse_ssh_config_content(content).unwrap();
        assert_eq!(hosts.len(), 2);

        // HPC host with ProxyJump
        assert_eq!(hosts[0].alias, "hpc");
        assert!(hosts[0].has_proxy_jump());
        assert_eq!(hosts[0].proxy_jump.len(), 1);
        assert_eq!(hosts[0].proxy_jump[0].host, "bastion");
        assert_eq!(hosts[0].proxy_jump[0].port, 22);
        assert!(!hosts[0].proxy_jump[0].port_specified);

        // Bastion host (no proxy)
        assert_eq!(hosts[1].alias, "bastion");
        assert!(!hosts[1].has_proxy_jump());
    }

    #[test]
    fn test_parse_multi_hop_proxy() {
        let content = r#"
Host compute
    HostName node001.internal
    User admin
    ProxyJump bastion,hpc
"#;

        let hosts = parse_ssh_config_content(content).unwrap();
        assert_eq!(hosts[0].proxy_jump.len(), 2);
        assert_eq!(hosts[0].proxy_jump[0].host, "bastion");
        assert_eq!(hosts[0].proxy_jump[1].host, "hpc");
    }

    #[test]
    fn test_parse_proxy_jump_with_user_port() {
        let content = r#"
Host target
    HostName target.example.com
    ProxyJump admin@jump.example.com:2222
"#;

        let hosts = parse_ssh_config_content(content).unwrap();
        let proxy = &hosts[0].proxy_jump[0];
        assert_eq!(proxy.user, Some("admin".to_string()));
        assert_eq!(proxy.host, "jump.example.com");
        assert_eq!(proxy.port, 2222);
    }

    #[test]
    fn test_parse_port_forwards() {
        let content = r#"
Host hpc
    HostName hpc.edu.cn
    LocalForward 8888 localhost:8888
    LocalForward 127.0.0.1:6006 localhost:6006
    RemoteForward 3000 localhost:3000
    DynamicForward 1080
"#;

        let hosts = parse_ssh_config_content(content).unwrap();
        let host = &hosts[0];

        assert_eq!(host.local_forwards.len(), 2);
        assert_eq!(host.local_forwards[0].local_port, 8888);
        assert_eq!(host.local_forwards[0].remote_port, 8888);
        assert_eq!(host.local_forwards[1].bind_address, "127.0.0.1");

        assert_eq!(host.remote_forwards.len(), 1);
        assert_eq!(host.remote_forwards[0].remote_port, 3000);

        assert_eq!(host.dynamic_forward, Some(1080));
    }

    #[test]
    fn test_proxy_jump_description() {
        let host = SshConfigHost {
            alias: "target".to_string(),
            proxy_jump: vec![
                ProxyJumpHost {
                    user: Some("admin".to_string()),
                    host: "jump1".to_string(),
                    port: 22,
                    port_specified: false,
                },
                ProxyJumpHost {
                    user: None,
                    host: "jump2".to_string(),
                    port: 2222,
                    port_specified: true,
                },
            ],
            ..Default::default()
        };

        let desc = host.proxy_jump_description().unwrap();
        assert_eq!(desc, "admin@jump1:22 → jump2:2222");
    }

    // ====================================================================
    // PortForwardRule::parse() tests
    // ====================================================================

    #[test]
    fn test_port_forward_rule_parse_basic() {
        // Simple: "port host:hostport"
        let rule = PortForwardRule::parse("8080 localhost:80").unwrap();
        assert_eq!(rule.bind_address, "localhost");
        assert_eq!(rule.local_port, 8080);
        assert_eq!(rule.remote_host, "localhost");
        assert_eq!(rule.remote_port, 80);
    }

    #[test]
    fn test_port_forward_rule_parse_with_bind_address() {
        // With bind: "bind_address:port host:hostport"
        let rule = PortForwardRule::parse("127.0.0.1:3000 db.internal:5432").unwrap();
        assert_eq!(rule.bind_address, "127.0.0.1");
        assert_eq!(rule.local_port, 3000);
        assert_eq!(rule.remote_host, "db.internal");
        assert_eq!(rule.remote_port, 5432);
    }

    #[test]
    fn test_port_forward_rule_parse_invalid_single_part() {
        assert!(PortForwardRule::parse("8080").is_none());
    }

    #[test]
    fn test_port_forward_rule_parse_invalid_no_remote_port() {
        assert!(PortForwardRule::parse("8080 localhost").is_none());
    }

    #[test]
    fn test_port_forward_rule_parse_invalid_non_numeric_port() {
        assert!(PortForwardRule::parse("abc localhost:80").is_none());
    }

    // ====================================================================
    // ProxyJumpHost::parse() tests
    // ====================================================================

    #[test]
    fn test_proxy_jump_host_parse_host_only() {
        let pj = ProxyJumpHost::parse("bastion.example.com").unwrap();
        assert_eq!(pj.user, None);
        assert_eq!(pj.host, "bastion.example.com");
        assert_eq!(pj.port, 22);
        assert!(!pj.port_specified);
    }

    #[test]
    fn test_proxy_jump_host_parse_user_and_host() {
        let pj = ProxyJumpHost::parse("admin@bastion").unwrap();
        assert_eq!(pj.user, Some("admin".to_string()));
        assert_eq!(pj.host, "bastion");
        assert_eq!(pj.port, 22);
    }

    #[test]
    fn test_proxy_jump_host_parse_host_and_port() {
        let pj = ProxyJumpHost::parse("jump.example.com:2222").unwrap();
        assert_eq!(pj.user, None);
        assert_eq!(pj.host, "jump.example.com");
        assert_eq!(pj.port, 2222);
        assert!(pj.port_specified);
    }

    #[test]
    fn test_proxy_jump_host_parse_full() {
        let pj = ProxyJumpHost::parse("root@gateway.corp:10022").unwrap();
        assert_eq!(pj.user, Some("root".to_string()));
        assert_eq!(pj.host, "gateway.corp");
        assert_eq!(pj.port, 10022);
        assert!(pj.port_specified);
    }

    #[test]
    fn test_proxy_jump_host_parse_invalid_port_defaults() {
        // Invalid port string falls back to 22
        let pj = ProxyJumpHost::parse("host:notaport").unwrap();
        assert_eq!(pj.host, "host");
        assert_eq!(pj.port, 22);
    }

    // ====================================================================
    // filter_importable_hosts() tests
    // ====================================================================

    #[test]
    fn test_filter_importable_hosts_removes_wildcards() {
        let hosts = vec![
            SshConfigHost {
                alias: "*".to_string(),
                ..Default::default()
            },
            SshConfigHost {
                alias: "prod".to_string(),
                hostname: Some("prod.example.com".to_string()),
                ..Default::default()
            },
            SshConfigHost {
                alias: "dev-*".to_string(),
                ..Default::default()
            },
        ];
        let filtered = filter_importable_hosts(hosts);
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].alias, "prod");
    }

    #[test]
    fn test_parse_multiple_aliases_on_same_host_line() {
        let content = r#"
Host web web-prod web-admin
    HostName web.example.com
    User deploy
"#;

        let hosts = parse_ssh_config_content(content).unwrap();
        assert_eq!(hosts.len(), 3);
        assert_eq!(hosts[0].alias, "web");
        assert_eq!(hosts[1].alias, "web-prod");
        assert_eq!(hosts[2].alias, "web-admin");
        assert!(
            hosts
                .iter()
                .all(|host| host.hostname.as_deref() == Some("web.example.com"))
        );
        assert!(
            hosts
                .iter()
                .all(|host| host.user.as_deref() == Some("deploy"))
        );
    }

    #[test]
    fn test_parse_ignores_match_blocks() {
        let content = r#"
Host target
    HostName target.example.com

Match host target
    User conditional-user
    Port 2200

Host other
    HostName other.example.com
"#;

        let hosts = parse_ssh_config_content(content).unwrap();
        assert_eq!(hosts.len(), 2);
        assert_eq!(hosts[0].alias, "target");
        assert_eq!(hosts[0].user, None);
        assert_eq!(hosts[0].port, None);
        assert_eq!(hosts[1].alias, "other");
        assert_eq!(hosts[1].hostname.as_deref(), Some("other.example.com"));
    }

    #[test]
    fn test_resolve_alias_ignores_match_blocks() {
        let content = r#"
Host target
    HostName target.example.com

Match host target
    Port 2200
    User conditional-user
"#;

        let resolved = resolve_ssh_config_host_content(content, "target")
            .unwrap()
            .unwrap();
        assert_eq!(resolved.host, "target.example.com");
        assert_eq!(resolved.port, 22);
        assert_eq!(resolved.user, None);
    }

    #[test]
    fn test_filter_importable_hosts_empty() {
        let filtered = filter_importable_hosts(vec![]);
        assert!(filtered.is_empty());
    }

    #[test]
    fn test_resolve_alias_applies_global_defaults() {
        let content = r#"
Host *
    User shared-user
    IdentityFile ~/.ssh/id_shared

Host app
    HostName app.example.com
"#;

        let resolved = resolve_ssh_config_host_content(content, "app")
            .unwrap()
            .unwrap();
        assert_eq!(resolved.host, "app.example.com");
        assert_eq!(resolved.user, Some("shared-user".to_string()));
        assert!(resolved.identity_file.unwrap().ends_with("/.ssh/id_shared"));
    }

    #[test]
    fn test_resolve_alias_flattens_proxy_jump_aliases() {
        let content = r#"
Host *
    User shared-user

Host bastion
    HostName jump.example.com
    Port 2222
    IdentityFile ~/.ssh/id_jump

Host target
    HostName target.internal
    ProxyJump bastion
"#;

        let resolved = resolve_ssh_config_host_content(content, "target")
            .unwrap()
            .unwrap();
        assert_eq!(resolved.host, "target.internal");
        assert_eq!(resolved.proxy_chain.len(), 1);
        assert_eq!(resolved.proxy_chain[0].alias, Some("bastion".to_string()));
        assert_eq!(resolved.proxy_chain[0].host, "jump.example.com");
        assert_eq!(resolved.proxy_chain[0].port, 2222);
        assert_eq!(
            resolved.proxy_chain[0].user,
            Some("shared-user".to_string())
        );
        assert!(
            resolved.proxy_chain[0]
                .identity_file
                .as_ref()
                .is_some_and(|path| path.ends_with("/.ssh/id_jump"))
        );
    }

    #[test]
    fn test_resolve_missing_alias_ignores_global_default_only_blocks() {
        let content = r#"
Host *
    User shared-user
    IdentityFile ~/.ssh/id_shared
"#;

        let resolved = resolve_ssh_config_host_content(content, "missing-alias").unwrap();
        assert!(resolved.is_none());
    }

    #[test]
    fn test_resolve_missing_alias_ignores_non_matching_explicit_selector_in_mixed_block() {
        let content = r#"
Host foo *
    User shared-user

Host foo
    HostName foo.example.com
"#;

        let resolved = resolve_ssh_config_host_content(content, "bar").unwrap();
        assert!(resolved.is_none());
    }

    #[test]
    fn test_resolve_proxy_jump_raw_host_inherits_defaults() {
        let content = r#"
Host *
    User shared-user
    IdentityFile ~/.ssh/id_shared

Host target
    HostName target.internal
    ProxyJump bastion.example.com
"#;

        let resolved = resolve_ssh_config_host_content(content, "target")
            .unwrap()
            .unwrap();
        assert_eq!(resolved.proxy_chain.len(), 1);
        assert_eq!(resolved.proxy_chain[0].host, "bastion.example.com");
        assert_eq!(
            resolved.proxy_chain[0].user,
            Some("shared-user".to_string())
        );
        assert!(
            resolved.proxy_chain[0]
                .identity_file
                .as_ref()
                .is_some_and(|path| path.ends_with("/.ssh/id_shared"))
        );
    }

    #[test]
    fn test_resolve_alias_proxy_jump_none_overrides_defaults() {
        let content = r#"
Host bastion
    HostName jump.example.com

Host target
    HostName target.internal
    ProxyJump none

Host *
    ProxyJump bastion
"#;

        let resolved = resolve_ssh_config_host_content(content, "target")
            .unwrap()
            .unwrap();
        assert!(resolved.proxy_chain.is_empty());
    }

    #[test]
    fn test_parse_include_tokens_keeps_quoted_paths_with_spaces() {
        let tokens =
            parse_include_tokens(r#""dir with spaces/config" plain.conf 'other dir/*.conf'"#);

        assert_eq!(
            tokens,
            vec![
                "dir with spaces/config".to_string(),
                "plain.conf".to_string(),
                "other dir/*.conf".to_string(),
            ]
        );
    }

    #[tokio::test]
    async fn test_parse_ssh_config_supports_include() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("config");
        let included = temp.path().join("included.conf");

        fs::write(
            &included,
            r#"
Host included-host
    HostName included.example.com
    User included-user
"#,
        )
        .await
        .unwrap();

        fs::write(
            &root,
            format!(
                "Include {}\n\nHost root-host\n    HostName root.example.com\n",
                included.to_string_lossy()
            ),
        )
        .await
        .unwrap();

        let hosts = parse_ssh_config(Some(root)).await.unwrap();
        assert_eq!(hosts.len(), 2);
        assert!(hosts.iter().any(|host| host.alias == "included-host"));
        assert!(hosts.iter().any(|host| host.alias == "root-host"));
    }

    #[tokio::test]
    async fn test_parse_ssh_config_supports_quoted_include_with_spaces() {
        let temp = tempfile::tempdir().unwrap();
        let include_dir = temp.path().join("ssh includes");
        let root = temp.path().join("config");
        let included = include_dir.join("quoted.conf");

        fs::create_dir_all(&include_dir).await.unwrap();
        fs::write(
            &included,
            r#"
Host included-host
    HostName included.example.com
"#,
        )
        .await
        .unwrap();

        fs::write(
            &root,
            format!(
                "Include \"{}\"\n\nHost root-host\n    HostName root.example.com\n",
                included.to_string_lossy()
            ),
        )
        .await
        .unwrap();

        let hosts = parse_ssh_config(Some(root)).await.unwrap();
        assert!(hosts.iter().any(|host| host.alias == "included-host"));
        assert!(hosts.iter().any(|host| host.alias == "root-host"));
    }

    #[tokio::test]
    async fn test_parse_ssh_config_include_cycle_is_ignored() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("config");
        let included = temp.path().join("included.conf");

        fs::write(
            &included,
            format!(
                "Include {}\n\nHost included-host\n    HostName included.example.com\n",
                root.to_string_lossy()
            ),
        )
        .await
        .unwrap();

        fs::write(
            &root,
            format!(
                "Include {}\n\nHost root-host\n    HostName root.example.com\n",
                included.to_string_lossy()
            ),
        )
        .await
        .unwrap();

        let hosts = parse_ssh_config(Some(root)).await.unwrap();
        assert_eq!(hosts.len(), 2);
        assert!(hosts.iter().any(|host| host.alias == "included-host"));
        assert!(hosts.iter().any(|host| host.alias == "root-host"));
    }

    #[tokio::test]
    async fn test_parse_ssh_config_allows_repeated_include() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("config");
        let included = temp.path().join("included.conf");

        fs::write(
            &included,
            r#"
Host included-host
    HostName included.example.com
"#,
        )
        .await
        .unwrap();

        fs::write(
            &root,
            format!(
                "Include {}\nInclude {}\n",
                included.to_string_lossy(),
                included.to_string_lossy()
            ),
        )
        .await
        .unwrap();

        let hosts = parse_ssh_config(Some(root)).await.unwrap();
        assert_eq!(hosts.len(), 2);
        assert_eq!(hosts[0].alias, "included-host");
        assert_eq!(hosts[1].alias, "included-host");
    }
}
