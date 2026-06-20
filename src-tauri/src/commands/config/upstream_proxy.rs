// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

use super::{ConfigState, auth_to_connect_info};
use crate::config::{
    GLOBAL_UPSTREAM_PROXY_PASSWORD_KEYCHAIN_ID, Keychain, SavedConnection, SavedUpstreamProxyAuth,
    SavedUpstreamProxyConfig, SavedUpstreamProxyPolicy, SavedUpstreamProxyProtocol,
    UpstreamProxyAuthForConnect, UpstreamProxyForConnect,
};
use crate::ssh::{
    UpstreamProxyAuth as RuntimeUpstreamProxyAuth,
    UpstreamProxyConfig as RuntimeUpstreamProxyConfig,
    UpstreamProxyProtocol as RuntimeUpstreamProxyProtocol, check_host_key_with_upstream_proxy,
    upstream_proxy_from_env,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::State;
use zeroize::Zeroizing;

/// Response from get_saved_connection_for_connect.
#[derive(Debug, Serialize)]
pub struct SavedConnectionForConnect {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: String,
    pub password: Option<String>,
    pub key_path: Option<String>,
    pub cert_path: Option<String>,
    pub passphrase: Option<String>,
    pub managed_key_id: Option<String>,
    pub name: String,
    pub agent_forwarding: bool,
    pub post_connect_command: Option<String>,
    pub proxy_chain: Vec<ProxyHopForConnect>,
    pub upstream_proxy: Option<UpstreamProxyForConnect>,
}

#[derive(Debug, Serialize)]
pub struct ProxyHopForConnect {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: String,
    pub password: Option<String>,
    pub key_path: Option<String>,
    pub cert_path: Option<String>,
    pub passphrase: Option<String>,
    pub managed_key_id: Option<String>,
    pub agent_forwarding: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalUpstreamProxyPasswordSaveResult {
    pub keychain_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestUpstreamProxyRouteRequest {
    pub host: String,
    pub port: u16,
}

#[tauri::command]
pub async fn save_global_upstream_proxy_password(
    state: State<'_, Arc<ConfigState>>,
    password: String,
) -> Result<GlobalUpstreamProxyPasswordSaveResult, String> {
    let password = Zeroizing::new(password);
    state
        .keychain
        .store(
            GLOBAL_UPSTREAM_PROXY_PASSWORD_KEYCHAIN_ID,
            password.as_str(),
        )
        .map_err(|err| format!("Failed to save global upstream proxy password: {}", err))?;
    Ok(GlobalUpstreamProxyPasswordSaveResult {
        keychain_id: GLOBAL_UPSTREAM_PROXY_PASSWORD_KEYCHAIN_ID.to_string(),
    })
}

#[tauri::command]
pub async fn delete_global_upstream_proxy_password(
    state: State<'_, Arc<ConfigState>>,
) -> Result<(), String> {
    state
        .keychain
        .delete(GLOBAL_UPSTREAM_PROXY_PASSWORD_KEYCHAIN_ID)
        .map_err(|err| format!("Failed to delete global upstream proxy password: {}", err))
}

#[tauri::command]
pub async fn test_upstream_proxy_route(
    state: State<'_, Arc<ConfigState>>,
    request: TestUpstreamProxyRouteRequest,
) -> Result<crate::ssh::HostKeyStatus, String> {
    let app_settings = crate::commands::app_settings::load_current_app_settings_value()
        .await
        .map_err(|error| format!("Failed to load app settings: {error}"))?;
    let upstream_proxy = global_upstream_proxy_to_connect_info(&app_settings, &state.keychain)
        .map(runtime_upstream_proxy_from_connect_info)
        .transpose()?;
    Ok(check_host_key_with_upstream_proxy(
        request.host.trim(),
        request.port,
        10,
        upstream_proxy.as_ref(),
    )
    .await)
}

#[tauri::command]
pub async fn resolve_upstream_proxy_for_connect(
    state: State<'_, Arc<ConfigState>>,
    policy: SavedUpstreamProxyPolicy,
) -> Result<Option<UpstreamProxyForConnect>, String> {
    let app_settings = crate::commands::app_settings::load_current_app_settings_value()
        .await
        .ok();

    Ok(upstream_proxy_to_connect_info(
        &policy,
        &state.keychain,
        app_settings.as_ref(),
    ))
}

fn runtime_upstream_proxy_from_connect_info(
    upstream_proxy: UpstreamProxyForConnect,
) -> Result<RuntimeUpstreamProxyConfig, String> {
    let auth = match upstream_proxy.auth {
        UpstreamProxyAuthForConnect::None => RuntimeUpstreamProxyAuth::None,
        UpstreamProxyAuthForConnect::Password { username, password } => {
            let password = password.ok_or("Upstream proxy password required")?;
            RuntimeUpstreamProxyAuth::Password { username, password }
        }
    };

    Ok(RuntimeUpstreamProxyConfig {
        protocol: match upstream_proxy.protocol {
            SavedUpstreamProxyProtocol::Socks5 => RuntimeUpstreamProxyProtocol::Socks5,
            SavedUpstreamProxyProtocol::HttpConnect => RuntimeUpstreamProxyProtocol::HttpConnect,
        },
        host: upstream_proxy.host,
        port: upstream_proxy.port,
        auth,
        remote_dns: upstream_proxy.remote_dns,
        no_proxy: upstream_proxy.no_proxy,
    })
}

fn upstream_proxy_config_to_connect_info(
    proxy: &SavedUpstreamProxyConfig,
    keychain: &Keychain,
) -> Option<UpstreamProxyForConnect> {
    let auth = match &proxy.auth {
        SavedUpstreamProxyAuth::None => UpstreamProxyAuthForConnect::None,
        SavedUpstreamProxyAuth::Password {
            username,
            keychain_id,
            plaintext_password,
        } => {
            // This DTO is transient: it hydrates keychain-backed proxy
            // credentials without storing them in the session tree.
            let password = plaintext_password
                .as_ref()
                .map(|password| password.as_str().to_string())
                .or_else(|| keychain_id.as_ref().and_then(|id| keychain.get(id).ok()))
                .map(Zeroizing::new);
            UpstreamProxyAuthForConnect::Password {
                username: username.clone(),
                password,
            }
        }
    };

    Some(UpstreamProxyForConnect {
        protocol: proxy.protocol,
        host: proxy.host.clone(),
        port: proxy.port,
        auth,
        remote_dns: proxy.remote_dns,
        no_proxy: proxy.no_proxy.clone(),
    })
}

fn global_upstream_proxy_to_connect_info(
    settings: &serde_json::Value,
    keychain: &Keychain,
) -> Option<UpstreamProxyForConnect> {
    let proxy_value = settings.pointer("/network/upstreamProxy")?;
    if proxy_value.is_null() {
        return None;
    }
    let proxy = serde_json::from_value::<SavedUpstreamProxyConfig>(proxy_value.clone()).ok()?;
    upstream_proxy_config_to_connect_info(&proxy, keychain)
}

fn runtime_upstream_proxy_to_connect_info(
    proxy: RuntimeUpstreamProxyConfig,
) -> UpstreamProxyForConnect {
    let auth = match proxy.auth {
        RuntimeUpstreamProxyAuth::None => UpstreamProxyAuthForConnect::None,
        RuntimeUpstreamProxyAuth::Password { username, password } => {
            UpstreamProxyAuthForConnect::Password {
                username,
                password: Some(password),
            }
        }
    };

    UpstreamProxyForConnect {
        protocol: match proxy.protocol {
            RuntimeUpstreamProxyProtocol::Socks5 => SavedUpstreamProxyProtocol::Socks5,
            RuntimeUpstreamProxyProtocol::HttpConnect => SavedUpstreamProxyProtocol::HttpConnect,
        },
        host: proxy.host,
        port: proxy.port,
        auth,
        remote_dns: proxy.remote_dns,
        no_proxy: proxy.no_proxy,
    }
}

pub(crate) fn upstream_proxy_to_connect_info(
    policy: &SavedUpstreamProxyPolicy,
    keychain: &Keychain,
    app_settings: Option<&serde_json::Value>,
) -> Option<UpstreamProxyForConnect> {
    match policy {
        SavedUpstreamProxyPolicy::Direct => None,
        SavedUpstreamProxyPolicy::Custom { proxy } => {
            upstream_proxy_config_to_connect_info(proxy, keychain)
        }
        SavedUpstreamProxyPolicy::UseGlobal => app_settings
            .and_then(|settings| global_upstream_proxy_to_connect_info(settings, keychain))
            .or_else(|| {
                upstream_proxy_from_env()
                    .ok()
                    .flatten()
                    .map(runtime_upstream_proxy_to_connect_info)
            }),
    }
}

/// Get saved connection with credentials for connecting.
#[tauri::command]
pub async fn get_saved_connection_for_connect(
    state: State<'_, Arc<ConfigState>>,
    id: String,
) -> Result<SavedConnectionForConnect, String> {
    let conn: SavedConnection = {
        let config = state.config.read();
        config
            .get_connection(&id)
            .cloned()
            .ok_or("Connection not found")?
    };
    let app_settings = crate::commands::app_settings::load_current_app_settings_value()
        .await
        .ok();

    let (auth_type, password, key_path, cert_path, passphrase, managed_key_id) =
        auth_to_connect_info(&conn.auth, &state.keychain);

    let proxy_chain: Vec<ProxyHopForConnect> = conn
        .proxy_chain
        .iter()
        .map(|hop| {
            let (
                hop_auth_type,
                hop_password,
                hop_key_path,
                hop_cert_path,
                hop_passphrase,
                hop_managed_key_id,
            ) = auth_to_connect_info(&hop.auth, &state.keychain);

            ProxyHopForConnect {
                host: hop.host.clone(),
                port: hop.port,
                username: hop.username.clone(),
                auth_type: hop_auth_type,
                password: hop_password,
                key_path: hop_key_path,
                cert_path: hop_cert_path,
                passphrase: hop_passphrase,
                managed_key_id: hop_managed_key_id,
                agent_forwarding: hop.agent_forwarding,
            }
        })
        .collect();

    Ok(SavedConnectionForConnect {
        host: conn.host.clone(),
        port: conn.port,
        username: conn.username.clone(),
        auth_type,
        password,
        key_path,
        cert_path,
        passphrase,
        managed_key_id,
        name: conn.name.clone(),
        agent_forwarding: conn.options.agent_forwarding,
        post_connect_command: conn.options.post_connect_command.clone(),
        proxy_chain,
        upstream_proxy: upstream_proxy_to_connect_info(
            &conn.upstream_proxy,
            &state.keychain,
            app_settings.as_ref(),
        ),
    })
}
