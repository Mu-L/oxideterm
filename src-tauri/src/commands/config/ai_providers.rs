// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

use super::{AiProviderConfig, ConfigState};
use crate::config::{AiProviderVault, Keychain, KeychainError, portable_aware_app_data_dir};
use std::collections::HashSet;
use std::sync::Arc;
use tauri::State;

/// Build the legacy provider vault bound to the current portable-aware data directory.
fn ai_provider_vault_for_app(app_handle: &tauri::AppHandle) -> Result<AiProviderVault, String> {
    let data_dir = portable_aware_app_data_dir(app_handle).map_err(|e| e.to_string())?;
    Ok(AiProviderVault::new(data_dir))
}

/// Attempt to migrate a provider key from legacy XOR vault to OS keychain.
pub(super) fn try_migrate_vault_to_keychain(
    app_handle: &tauri::AppHandle,
    ai_keychain: &Keychain,
    provider_id: &str,
) -> Option<String> {
    let vault = match ai_provider_vault_for_app(app_handle) {
        Ok(vault) => vault,
        Err(_) => return None,
    };

    if !vault.exists(provider_id) {
        return None;
    }

    match vault.load(provider_id) {
        Ok(key) => {
            tracing::info!(
                "Migrating AI key for provider {} from vault to keychain",
                provider_id
            );
            match ai_keychain.store(provider_id, &key) {
                Ok(()) => {
                    if let Err(e) = vault.delete(provider_id) {
                        tracing::warn!(
                            "Failed to delete vault file after migration for {}: {}",
                            provider_id,
                            e
                        );
                    }
                    tracing::info!(
                        "Successfully migrated AI key for provider {} to keychain",
                        provider_id
                    );
                    Some((*key).clone())
                }
                Err(e) => {
                    tracing::error!(
                        "Failed to store provider {} key in keychain: {}",
                        provider_id,
                        e
                    );
                    Some((*key).clone())
                }
            }
        }
        Err(e) => {
            tracing::warn!(
                "Failed to read vault for provider {} during migration: {}",
                provider_id,
                e
            );
            None
        }
    }
}

/// Sync AI provider configurations from frontend settings.
#[tauri::command]
pub async fn sync_ai_providers(
    state: State<'_, Arc<ConfigState>>,
    providers: Vec<AiProviderConfig>,
    active_provider_id: Option<String>,
) -> Result<(), String> {
    let mut lock = state.ai_providers.write();
    *lock = (providers, active_provider_id);
    tracing::debug!(
        "AI providers synced from frontend ({} providers)",
        lock.0.len()
    );
    Ok(())
}

/// Set API key for a specific AI provider in the OS keychain.
#[tauri::command]
pub async fn set_ai_provider_api_key(
    state: State<'_, Arc<ConfigState>>,
    provider_id: String,
    api_key: String,
) -> Result<(), String> {
    if api_key.is_empty() {
        state
            .ai_keychain
            .delete(&provider_id)
            .map_err(|e| format!("Failed to delete provider key: {}", e))?;
        state.api_key_cache.write().remove(&provider_id);
    } else {
        state
            .ai_keychain
            .store(&provider_id, &api_key)
            .map_err(|e| format!("Failed to save provider key to keychain: {}", e))?;
        state
            .api_key_cache
            .write()
            .insert(provider_id.clone(), api_key);
    }
    tracing::info!(
        "AI provider key for {} saved to system keychain",
        provider_id
    );
    Ok(())
}

/// Get API key for a specific AI provider, migrating legacy vault storage if needed.
#[tauri::command]
pub async fn get_ai_provider_api_key(
    app_handle: tauri::AppHandle,
    state: State<'_, Arc<ConfigState>>,
    provider_id: String,
) -> Result<Option<String>, String> {
    {
        let cache = state.api_key_cache.read();
        if let Some(cached_key) = cache.get(&provider_id) {
            tracing::debug!(
                "AI provider key for {} served from session cache",
                provider_id
            );
            return Ok(Some(cached_key.clone()));
        }
    }

    match state.ai_keychain.get(&provider_id) {
        Ok(key) => {
            tracing::debug!(
                "AI provider key for {} found in keychain (len={})",
                provider_id,
                key.len()
            );
            state.api_key_cache.write().insert(provider_id, key.clone());
            return Ok(Some(key));
        }
        Err(e) => {
            let is_not_found = matches!(&e, KeychainError::NotFound(_))
                || e.to_string().to_lowercase().contains("no entry");
            if !is_not_found {
                tracing::warn!("Keychain error for provider {}: {}", provider_id, e);
            }
        }
    }

    if let Some(key) = try_migrate_vault_to_keychain(&app_handle, &state.ai_keychain, &provider_id)
    {
        state.api_key_cache.write().insert(provider_id, key.clone());
        return Ok(Some(key));
    }

    Ok(None)
}

/// Check whether an API key exists for a specific AI provider.
#[tauri::command]
pub async fn has_ai_provider_api_key(
    app_handle: tauri::AppHandle,
    state: State<'_, Arc<ConfigState>>,
    provider_id: String,
) -> Result<bool, String> {
    match state.ai_keychain.exists(&provider_id) {
        Ok(true) => return Ok(true),
        Ok(false) => {}
        Err(_) => {}
    }

    let vault = ai_provider_vault_for_app(&app_handle)?;
    Ok(vault.exists(&provider_id))
}

/// Delete API key for a specific AI provider from all storage locations.
#[tauri::command]
pub async fn delete_ai_provider_api_key(
    app_handle: tauri::AppHandle,
    state: State<'_, Arc<ConfigState>>,
    provider_id: String,
) -> Result<(), String> {
    if let Err(e) = state.ai_keychain.delete(&provider_id) {
        tracing::debug!(
            "Keychain delete for provider {} (may not exist): {}",
            provider_id,
            e
        );
    }

    let vault = ai_provider_vault_for_app(&app_handle)?;
    if let Err(e) = vault.delete(&provider_id) {
        tracing::debug!(
            "Vault delete for provider {} (may not exist): {}",
            provider_id,
            e
        );
    }

    tracing::info!(
        "AI provider key for {} deleted from all storage locations",
        provider_id
    );
    Ok(())
}

/// List all provider IDs that have stored API keys.
pub(crate) fn collect_ai_provider_key_ids(
    app_handle: &tauri::AppHandle,
    state: &ConfigState,
) -> Result<Vec<String>, String> {
    let mut providers = HashSet::new();

    let vault = ai_provider_vault_for_app(app_handle)?;
    if let Ok(vault_providers) = vault.list_providers() {
        for provider_id in vault_providers {
            providers.insert(provider_id);
        }
    }

    let (configured_providers, active_provider) = state.ai_providers.read().clone();
    let mut keychain_candidates = configured_providers
        .into_iter()
        .map(|provider| provider.id)
        .collect::<Vec<_>>();
    if let Some(provider_id) = active_provider {
        keychain_candidates.push(provider_id);
    }

    for provider_id in [
        "builtin-openai",
        "builtin-anthropic",
        "builtin-gemini",
        "builtin-ollama",
    ] {
        keychain_candidates.push(provider_id.to_string());
    }

    for provider_id in keychain_candidates {
        if state.ai_keychain.exists(&provider_id).unwrap_or(false) {
            providers.insert(provider_id);
        }
    }

    Ok(providers.into_iter().collect())
}

#[tauri::command]
pub async fn list_ai_provider_keys(
    app_handle: tauri::AppHandle,
    state: State<'_, Arc<ConfigState>>,
) -> Result<Vec<String>, String> {
    collect_ai_provider_key_ids(&app_handle, state.inner().as_ref())
}
