// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

//! Shared SSH authentication helpers.

use std::fmt::Display;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use russh::MethodKind;
use russh::Signer as RusshSigner;
use russh::client;
use russh::keys::HashAlg;
use russh::keys::agent::AgentIdentity;
use russh::keys::key::PrivateKeyWithHashAlg;
use russh::keys::ssh_key::private::KeypairData;
use russh::keys::{Algorithm, Certificate, PrivateKey};
use signature::Signer as SignatureSigner;
use ssh_encoding::Encode;
use tauri::AppHandle;
use thiserror::Error;
use tracing::{debug, info};

use super::client::ClientHandler;
use super::error::SshError;
use super::keyboard_interactive::{
    EVENT_KBI_PROMPT, EVENT_KBI_RESULT, KbiPrompt, KbiPromptEvent, KbiResultEvent, cleanup_pending,
    register_pending,
};
use crate::path_utils::expand_tilde;

pub(crate) const DEFAULT_AUTH_TIMEOUT_SECS: u64 = 30;
const PASSWORD_RETRY_DELAY_MS: u64 = 500;
const RSA_AUTH_ALGORITHMS: [Option<HashAlg>; 3] =
    [Some(HashAlg::Sha512), Some(HashAlg::Sha256), None];

#[derive(Debug, Error)]
enum LocalSignerError {
    #[error(transparent)]
    Send(#[from] russh::SendError),
    #[error("{0}")]
    Sign(String),
}

struct LocalKeySigner {
    key: Arc<PrivateKey>,
}

impl LocalKeySigner {
    fn new(key: Arc<PrivateKey>) -> Self {
        Self { key }
    }
}

impl RusshSigner for LocalKeySigner {
    type Error = LocalSignerError;

    fn auth_sign(
        &mut self,
        _key: &AgentIdentity,
        hash_alg: Option<HashAlg>,
        to_sign: Vec<u8>,
    ) -> impl Future<Output = Result<Vec<u8>, Self::Error>> + Send {
        let key = Arc::clone(&self.key);
        async move { sign_auth_payload_with_hash_alg(key.as_ref(), hash_alg, to_sign) }
    }
}

pub(crate) fn build_client_config() -> client::Config {
    client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        window_size: 32 * 1024 * 1024,
        maximum_packet_size: 256 * 1024,
        ..Default::default()
    }
}

pub(crate) fn should_retry_password_auth(result: &client::AuthResult) -> bool {
    matches!(
        result,
        client::AuthResult::Failure {
            partial_success: false,
            ..
        }
    )
}

pub(crate) async fn authenticate_password_with<F, Fut, E>(
    mut attempt: F,
    timeout_secs: u64,
    timeout_message: &str,
    retry_timeout_message: &str,
    retry_debug_label: &str,
) -> Result<client::AuthResult, SshError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<client::AuthResult, E>>,
    E: Display,
{
    let result = tokio::time::timeout(Duration::from_secs(timeout_secs), attempt())
        .await
        .map_err(|_| SshError::Timeout(timeout_message.to_string()))?
        .map_err(|e| SshError::AuthenticationFailed(e.to_string()))?;

    if should_retry_password_auth(&result) {
        debug!(
            "{} attempt 1 returned {:?}, retrying after {}ms",
            retry_debug_label, result, PASSWORD_RETRY_DELAY_MS
        );
        tokio::time::sleep(Duration::from_millis(PASSWORD_RETRY_DELAY_MS)).await;

        tokio::time::timeout(Duration::from_secs(timeout_secs), attempt())
            .await
            .map_err(|_| SshError::Timeout(retry_timeout_message.to_string()))?
            .map_err(|e| SshError::AuthenticationFailed(e.to_string()))
    } else {
        Ok(result)
    }
}

pub(crate) async fn authenticate_password(
    handle: &mut client::Handle<ClientHandler>,
    username: &str,
    password: &str,
    timeout_secs: u64,
    timeout_message: &str,
    retry_timeout_message: &str,
    retry_debug_label: &str,
) -> Result<client::AuthResult, SshError> {
    let result = tokio::time::timeout(
        Duration::from_secs(timeout_secs),
        handle.authenticate_password(username, password),
    )
    .await
    .map_err(|_| SshError::Timeout(timeout_message.to_string()))?
    .map_err(|e| SshError::AuthenticationFailed(e.to_string()))?;

    if should_retry_password_auth(&result) {
        debug!(
            "{} attempt 1 returned {:?}, retrying after {}ms",
            retry_debug_label, result, PASSWORD_RETRY_DELAY_MS
        );
        tokio::time::sleep(Duration::from_millis(PASSWORD_RETRY_DELAY_MS)).await;

        tokio::time::timeout(
            Duration::from_secs(timeout_secs),
            handle.authenticate_password(username, password),
        )
        .await
        .map_err(|_| SshError::Timeout(retry_timeout_message.to_string()))?
        .map_err(|e| SshError::AuthenticationFailed(e.to_string()))
    } else {
        Ok(result)
    }
}

pub(crate) fn ensure_auth_success(
    authenticated: &client::AuthResult,
    rejection_context: impl Into<String>,
) -> Result<(), SshError> {
    if authenticated.success() {
        Ok(())
    } else {
        Err(SshError::AuthenticationFailed(format!(
            "{} ({:?})",
            rejection_context.into(),
            authenticated
        )))
    }
}

/// Timeout for waiting on user KBI input during auth chaining (60s)
const KBI_CHAIN_USER_TIMEOUT: Duration = Duration::from_secs(60);

fn emit_kbi_chain_result(
    app: &AppHandle,
    auth_flow_id: &str,
    success: bool,
    error: Option<String>,
) {
    use tauri::Emitter;

    let _ = app.emit(
        EVENT_KBI_RESULT,
        KbiResultEvent {
            auth_flow_id: auth_flow_id.to_string(),
            success,
            error,
            session_id: None,
            ws_port: None,
            ws_token: None,
        },
    );
}

/// Check if an auth result indicates partial success with keyboard-interactive
/// as a remaining method, and if so, run the KBI flow on the same handle.
///
/// Returns `Ok(true)` if KBI chaining was performed and succeeded.
/// Returns `Ok(false)` if no chaining was needed (result is not partial_success w/ KBI).
/// Returns `Err` if chaining was attempted but failed.
pub(crate) async fn try_kbi_auth_chain(
    result: &client::AuthResult,
    handle: &mut client::Handle<ClientHandler>,
    username: &str,
    app: &AppHandle,
) -> Result<bool, SshError> {
    use tauri::Emitter;

    let remaining = match result {
        client::AuthResult::Failure {
            partial_success: true,
            remaining_methods,
        } => remaining_methods,
        _ => return Ok(false),
    };

    if !remaining.contains(&MethodKind::KeyboardInteractive) {
        return Ok(false);
    }

    info!(
        "Auth partial success, server requires keyboard-interactive. Starting KBI chain for {}",
        username
    );

    // Generate unique flow ID for this chained KBI
    let auth_flow_id = uuid::Uuid::new_v4().to_string();

    // Start keyboard-interactive on the same handle
    let mut kbi_result = handle
        .authenticate_keyboard_interactive_start(username, None::<String>)
        .await
        .map_err(|e| {
            let err = format!("KBI chain start failed: {}", e);
            emit_kbi_chain_result(app, &auth_flow_id, false, Some(err.clone()));
            SshError::AuthenticationFailed(err)
        })?;

    // KBI prompt/response loop (same logic as kbi.rs but reused inline)
    use russh::client::KeyboardInteractiveAuthResponse;

    loop {
        match kbi_result {
            KeyboardInteractiveAuthResponse::Success => {
                info!("KBI chain: authentication successful");
                emit_kbi_chain_result(app, &auth_flow_id, true, None);
                return Ok(true);
            }
            KeyboardInteractiveAuthResponse::Failure { .. } => {
                let err_msg =
                    "KBI chain: server rejected keyboard-interactive responses".to_string();
                emit_kbi_chain_result(app, &auth_flow_id, false, Some(err_msg.clone()));
                return Err(SshError::AuthenticationFailed(err_msg));
            }
            KeyboardInteractiveAuthResponse::InfoRequest {
                name,
                instructions,
                prompts,
            } => {
                debug!(
                    "KBI chain {}: InfoRequest with {} prompts",
                    auth_flow_id,
                    prompts.len()
                );

                let prompts_for_frontend: Vec<KbiPrompt> = prompts
                    .iter()
                    .map(|p| KbiPrompt {
                        prompt: p.prompt.clone(),
                        echo: p.echo,
                    })
                    .collect();

                // Register pending request BEFORE emitting event
                let rx = register_pending(auth_flow_id.clone());

                // Emit prompt event to frontend
                app.emit(
                    EVENT_KBI_PROMPT,
                    KbiPromptEvent {
                        auth_flow_id: auth_flow_id.clone(),
                        name,
                        instructions,
                        prompts: prompts_for_frontend,
                        chained: true,
                    },
                )
                .map_err(|e| {
                    // Clean up the pending request since frontend will never respond
                    cleanup_pending(&auth_flow_id);
                    let err = format!("KBI chain: failed to emit prompt event: {}", e);
                    emit_kbi_chain_result(app, &auth_flow_id, false, Some(err.clone()));
                    SshError::AuthenticationFailed(err)
                })?;

                // Wait for frontend response with 60s timeout
                let responses = tokio::time::timeout(KBI_CHAIN_USER_TIMEOUT, rx)
                    .await
                    .map_err(|_| {
                        cleanup_pending(&auth_flow_id);
                        let err = "KBI chain: no response within 60 seconds".to_string();
                        emit_kbi_chain_result(app, &auth_flow_id, false, Some(err.clone()));
                        SshError::Timeout(err)
                    })?
                    .map_err(|_| {
                        cleanup_pending(&auth_flow_id);
                        let err = "KBI chain: response channel closed".to_string();
                        emit_kbi_chain_result(app, &auth_flow_id, false, Some(err.clone()));
                        SshError::AuthenticationFailed(err)
                    })?
                    .map_err(|e| {
                        cleanup_pending(&auth_flow_id);
                        let err = format!("KBI chain: {}", e);
                        emit_kbi_chain_result(app, &auth_flow_id, false, Some(err.clone()));
                        SshError::AuthenticationFailed(err)
                    })?;

                debug!(
                    "KBI chain {}: got {} responses from frontend",
                    auth_flow_id,
                    responses.len()
                );

                let raw_responses: Vec<String> = responses.iter().map(|r| (**r).clone()).collect();
                kbi_result = handle
                    .authenticate_keyboard_interactive_respond(raw_responses)
                    .await
                    .map_err(|e| {
                        let err = format!("KBI chain respond failed: {}", e);
                        emit_kbi_chain_result(app, &auth_flow_id, false, Some(err.clone()));
                        SshError::AuthenticationFailed(err)
                    })?;
            }
        }
    }
}

pub(crate) fn load_private_key_material(
    key_path: &str,
    passphrase: Option<&str>,
) -> Result<Arc<PrivateKey>, SshError> {
    let expanded_key_path = expand_tilde(key_path);
    let key = russh::keys::load_secret_key(&expanded_key_path, passphrase)
        .map_err(|e| SshError::KeyError(e.to_string()))?;

    Ok(Arc::new(key))
}

pub(crate) async fn resolve_server_rsa_preference(
    handle: &client::Handle<ClientHandler>,
) -> Option<Option<HashAlg>> {
    match handle.best_supported_rsa_hash().await {
        Ok(server_preference) => {
            if let Some(hash_alg) = server_preference {
                debug!(
                    "Server advertised RSA hash preference via EXT_INFO: {:?}",
                    hash_alg
                );
            } else {
                debug!(
                    "Server did not advertise RSA hash preference, falling back to local ordering"
                );
            }
            server_preference
        }
        Err(error) => {
            debug!(
                "Failed to query server RSA hash preference via EXT_INFO: {}",
                error
            );
            None
        }
    }
}

pub(crate) fn auth_algorithm_attempt_order(
    is_rsa: bool,
    server_preference: Option<Option<HashAlg>>,
) -> Vec<Option<HashAlg>> {
    if !is_rsa {
        return vec![None];
    }

    match server_preference {
        Some(None) => vec![None],
        Some(Some(preferred_hash)) => {
            let mut algorithms = vec![Some(preferred_hash)];
            algorithms.extend(
                RSA_AUTH_ALGORITHMS
                    .iter()
                    .copied()
                    .filter(|candidate| *candidate != Some(preferred_hash)),
            );
            algorithms
        }
        None => RSA_AUTH_ALGORITHMS.to_vec(),
    }
}

pub(crate) fn server_allows_more_publickey_attempts(result: &client::AuthResult) -> bool {
    matches!(
        result,
        client::AuthResult::Failure {
            remaining_methods,
            ..
        } if remaining_methods.contains(&MethodKind::PublicKey)
    )
}

/// Authenticate with a public key, negotiating the best RSA signature algorithm.
///
/// For RSA keys, the SSH server may advertise supported signature algorithms via
/// RFC 8308 EXT_INFO. If available, we use the server's preferred algorithm.
/// Otherwise, we try algorithms from strongest to weakest:
///   `rsa-sha2-512` → `rsa-sha2-256` → `ssh-rsa` (SHA-1, legacy)
///
/// For non-RSA keys (Ed25519, ECDSA), the hash algorithm is ignored by russh,
/// so this function works correctly for all key types.
///
/// The private key material (`Arc<PrivateKey>`) is reference-counted and never
/// cloned — only the Arc pointer is duplicated across retry iterations.
pub(crate) async fn authenticate_publickey_best_algo(
    handle: &mut client::Handle<ClientHandler>,
    username: &str,
    key: Arc<PrivateKey>,
) -> Result<client::AuthResult, SshError> {
    let is_rsa = matches!(key.algorithm(), Algorithm::Rsa { .. });
    let algorithms =
        auth_algorithm_attempt_order(is_rsa, resolve_server_rsa_preference(handle).await);

    try_publickey_with_algorithm_fallback(handle, username, key, &algorithms).await
}

pub(crate) async fn authenticate_certificate_best_algo(
    handle: &mut client::Handle<ClientHandler>,
    username: &str,
    key: Arc<PrivateKey>,
    cert: Certificate,
) -> Result<client::AuthResult, SshError> {
    let is_rsa = matches!(cert.algorithm(), Algorithm::Rsa { .. });
    let algorithms =
        auth_algorithm_attempt_order(is_rsa, resolve_server_rsa_preference(handle).await);
    let mut signer = LocalKeySigner::new(key);
    let mut last_result = None;

    for (index, hash_alg) in algorithms.iter().copied().enumerate() {
        match handle
            .authenticate_certificate_with(username, cert.clone(), hash_alg, &mut signer)
            .await
        {
            Ok(client::AuthResult::Success) => {
                debug!("Certificate auth succeeded with algorithm {:?}", hash_alg);
                return Ok(client::AuthResult::Success);
            }
            Ok(result) => {
                if !server_allows_more_publickey_attempts(&result) {
                    debug!(
                        "Server removed publickey from allowed methods after certificate attempt {:?}",
                        hash_alg
                    );
                    return Ok(result);
                }

                if index < algorithms.len() - 1 {
                    debug!(
                        "Certificate auth with {:?} rejected, trying next algorithm",
                        hash_alg
                    );
                }
                last_result = Some(result);
            }
            Err(error) => {
                return Err(SshError::AuthenticationFailed(format!(
                    "Certificate authentication failed: {}",
                    error
                )));
            }
        }
    }

    last_result.map_or_else(
        || {
            Err(SshError::AuthenticationFailed(
                "Certificate authentication failed after exhausting compatible signature algorithms"
                    .to_string(),
            ))
        },
        Ok,
    )
}

/// Try public key authentication with RSA signature algorithms in descending
/// strength order: SHA-512 → SHA-256 → SHA-1.
///
/// Stops early if:
/// - Authentication succeeds
/// - The server removes `publickey` from remaining methods (no more attempts allowed)
/// - A connection-level error occurs (not an auth rejection)
async fn try_publickey_with_algorithm_fallback(
    handle: &mut client::Handle<ClientHandler>,
    username: &str,
    key: Arc<PrivateKey>,
    algorithms: &[Option<HashAlg>],
) -> Result<client::AuthResult, SshError> {
    let mut last_result = None;

    for (i, hash_alg) in algorithms.iter().copied().enumerate() {
        // Arc::clone only increments the reference count — the private key
        // material stays in a single heap allocation, not duplicated.
        let key_material = PrivateKeyWithHashAlg::new(Arc::clone(&key), hash_alg);

        match handle.authenticate_publickey(username, key_material).await {
            Ok(client::AuthResult::Success) => {
                debug!("Public key auth succeeded with algorithm {:?}", hash_alg);
                return Ok(client::AuthResult::Success);
            }
            Ok(result) => {
                if !server_allows_more_publickey_attempts(&result) {
                    debug!(
                        "Server removed publickey from allowed methods after {:?}, \
                         stopping algorithm negotiation",
                        hash_alg
                    );
                    return Ok(result);
                }

                if i < algorithms.len() - 1 {
                    debug!(
                        "Public key auth with {:?} rejected, trying next algorithm",
                        hash_alg
                    );
                }
                last_result = Some(result);
            }
            Err(e) => {
                // Connection-level error (not auth rejection) — stop immediately
                return Err(SshError::AuthenticationFailed(e.to_string()));
            }
        }
    }

    last_result.map_or_else(
        || {
            Err(SshError::AuthenticationFailed(
                "Public key authentication failed with all RSA signature algorithms".to_string(),
            ))
        },
        Ok,
    )
}

pub(crate) fn load_certificate_auth_material(
    key_path: &str,
    cert_path: &str,
    passphrase: Option<&str>,
) -> Result<(Arc<PrivateKey>, Certificate), SshError> {
    let key = load_private_key_material(key_path, passphrase)?;
    let expanded_cert_path = expand_tilde(cert_path);
    let cert = russh::keys::load_openssh_certificate(&expanded_cert_path).map_err(|e| {
        SshError::CertificateParseError(format!("Failed to load certificate: {}", e))
    })?;

    Ok((key, cert))
}

fn sign_auth_payload_with_hash_alg(
    key: &PrivateKey,
    hash_alg: Option<HashAlg>,
    mut data: Vec<u8>,
) -> Result<Vec<u8>, LocalSignerError> {
    let signature = match key.key_data() {
        KeypairData::Rsa(rsa_keypair) => {
            SignatureSigner::try_sign(&(rsa_keypair, hash_alg), data.as_slice())
                .map_err(|error| LocalSignerError::Sign(error.to_string()))?
        }
        keypair => SignatureSigner::try_sign(keypair, data.as_slice())
            .map_err(|error| LocalSignerError::Sign(error.to_string()))?,
    };

    let mut encoded_signature = Vec::new();
    signature
        .encode(&mut encoded_signature)
        .map_err(|error| LocalSignerError::Sign(error.to_string()))?;
    encoded_signature
        .encode(&mut data)
        .map_err(|error| LocalSignerError::Sign(error.to_string()))?;
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rngs::OsRng;
    use russh::MethodSet;
    use russh::keys::Algorithm;
    use russh::keys::ssh_key::LineEnding;
    use tempfile::tempdir;

    fn write_test_key(path: &std::path::Path, passphrase: Option<&str>) {
        let mut rng = OsRng;
        let key = PrivateKey::random(&mut rng, Algorithm::Ed25519).unwrap();
        let key = match passphrase {
            Some(pass) => key.encrypt(&mut rng, pass).unwrap(),
            None => key,
        };

        key.write_openssh_file(path, LineEnding::LF).unwrap();
    }

    #[test]
    fn test_build_client_config_matches_expected_runtime_defaults() {
        let config = build_client_config();

        assert_eq!(config.keepalive_interval, Some(Duration::from_secs(30)));
        assert_eq!(config.keepalive_max, 3);
        assert_eq!(config.window_size, 32 * 1024 * 1024);
        assert_eq!(config.maximum_packet_size, 256 * 1024);
        assert!(config.inactivity_timeout.is_none());
    }

    #[test]
    fn test_should_retry_password_auth_only_on_non_partial_failure() {
        assert!(should_retry_password_auth(&client::AuthResult::Failure {
            remaining_methods: MethodSet::empty(),
            partial_success: false,
        }));
        assert!(!should_retry_password_auth(&client::AuthResult::Failure {
            remaining_methods: MethodSet::empty(),
            partial_success: true,
        }));
        assert!(!should_retry_password_auth(&client::AuthResult::Success));
    }

    #[test]
    fn test_auth_algorithm_attempt_order_uses_server_preference_first() {
        assert_eq!(
            auth_algorithm_attempt_order(true, Some(Some(HashAlg::Sha256))),
            vec![Some(HashAlg::Sha256), Some(HashAlg::Sha512), None]
        );
    }

    #[test]
    fn test_auth_algorithm_attempt_order_respects_explicit_sha1_only_server() {
        assert_eq!(auth_algorithm_attempt_order(true, Some(None)), vec![None]);
    }

    #[test]
    fn test_auth_algorithm_attempt_order_skips_hash_negotiation_for_non_rsa_keys() {
        assert_eq!(
            auth_algorithm_attempt_order(false, Some(Some(HashAlg::Sha512))),
            vec![None]
        );
    }

    #[tokio::test]
    async fn test_authenticate_password_retries_once_on_non_partial_failure() {
        let mut attempts = 0;
        let result = authenticate_password_with(
            || {
                attempts += 1;
                async move {
                    if attempts == 1 {
                        Ok::<_, std::io::Error>(client::AuthResult::Failure {
                            remaining_methods: MethodSet::empty(),
                            partial_success: false,
                        })
                    } else {
                        Ok::<_, std::io::Error>(client::AuthResult::Success)
                    }
                }
            },
            30,
            "timeout",
            "timeout retry",
            "password auth",
        )
        .await
        .unwrap();

        assert_eq!(attempts, 2);
        assert!(result.success());
    }

    #[tokio::test]
    async fn test_authenticate_password_does_not_retry_partial_success_failure() {
        let mut attempts = 0;
        let result = authenticate_password_with(
            || {
                attempts += 1;
                async move {
                    Ok::<_, std::io::Error>(client::AuthResult::Failure {
                        remaining_methods: MethodSet::empty(),
                        partial_success: true,
                    })
                }
            },
            30,
            "timeout",
            "timeout retry",
            "password auth",
        )
        .await
        .unwrap();

        assert_eq!(attempts, 1);
        assert!(!result.success());
    }

    #[test]
    fn test_ensure_auth_success_rejects_failed_auth_result() {
        let error = ensure_auth_success(
            &client::AuthResult::Failure {
                remaining_methods: MethodSet::empty(),
                partial_success: false,
            },
            "Authentication rejected by server",
        )
        .unwrap_err();

        assert!(matches!(error, SshError::AuthenticationFailed(_)));
        assert!(
            error
                .to_string()
                .contains("Authentication rejected by server")
        );
    }

    #[test]
    fn test_load_private_key_material_loads_generated_key() {
        let temp_dir = tempdir().unwrap();
        let key_path = temp_dir.path().join("id_ed25519");
        write_test_key(&key_path, None);

        load_private_key_material(key_path.to_str().unwrap(), None).unwrap();
    }

    #[test]
    fn test_load_certificate_auth_material_returns_parse_error_for_invalid_certificate() {
        let temp_dir = tempdir().unwrap();
        let key_path = temp_dir.path().join("id_ed25519");
        let cert_path = temp_dir.path().join("id_ed25519-cert.pub");
        write_test_key(&key_path, None);
        std::fs::write(&cert_path, "not a certificate").unwrap();

        let error = load_certificate_auth_material(
            key_path.to_str().unwrap(),
            cert_path.to_str().unwrap(),
            None,
        )
        .unwrap_err();

        assert!(matches!(error, SshError::CertificateParseError(_)));
    }
}
