// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

//! Shared SSH authentication helpers.

use std::fmt::Display;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use russh::MethodKind;
use russh::client;
use russh::keys::key::PrivateKeyWithHashAlg;
use russh::keys::{Certificate, PrivateKey};
use tauri::AppHandle;
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

pub(crate) fn load_public_key_auth_material(
    key_path: &str,
    passphrase: Option<&str>,
) -> Result<PrivateKeyWithHashAlg, SshError> {
    Ok(PrivateKeyWithHashAlg::new(
        load_private_key_material(key_path, passphrase)?,
        None,
    ))
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
    fn test_load_public_key_auth_material_loads_generated_key() {
        let temp_dir = tempdir().unwrap();
        let key_path = temp_dir.path().join("id_ed25519");
        write_test_key(&key_path, None);

        load_public_key_auth_material(key_path.to_str().unwrap(), None).unwrap();
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
