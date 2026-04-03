// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

/**
 * ModelSelector - Provider/Model dropdown for AI chat header
 *
 * Compact dropdown showing active provider and model.
 * Groups available models by provider with visual indicators.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Check, Key, Circle, Settings, RefreshCw } from 'lucide-react';
import { useSettingsStore } from '../../store/settingsStore';
import { useToastStore } from '../../hooks/useToast';
import { api } from '../../lib/api';
import { aiFetch } from '../../lib/ai/aiFetch';
import { cn } from '../../lib/utils';
import type { AiProvider } from '../../types';

type ModelSelectorProps = {
  onOpenSettings?: () => void;
};

export const ModelSelector = ({ onOpenSettings }: ModelSelectorProps) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [keyStatus, setKeyStatus] = useState<Record<string, boolean>>({});
  const [providerOnline, setProviderOnline] = useState<Record<string, boolean>>({});
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const aiSettings = useSettingsStore((s) => s.settings.ai);
  const setActiveProvider = useSettingsStore((s) => s.setActiveProvider);
  const refreshProviderModels = useSettingsStore((s) => s.refreshProviderModels);

  const activeProvider = aiSettings.providers.find((p) => p.id === aiSettings.activeProviderId);
  const activeModel = aiSettings.activeModel || activeProvider?.defaultModel || '';

  const checkLocalProviderOnline = useCallback(async (baseUrl: string, endpoint: string, headers?: Record<string, string>) => {
    const cleanBaseUrl = baseUrl.replace(/\/+$/, '');
    try {
      const resp = await aiFetch(`${cleanBaseUrl}${endpoint}`, { timeoutMs: 3000, headers });
      return resp.ok;
    } catch {
      return false;
    }
  }, []);

  /** Heuristic: is this a local (LAN) base URL? */
  const isLocalUrl = useCallback((baseUrl: string) => {
    try {
      const url = new URL(baseUrl);
      const host = url.hostname.toLowerCase();
      if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1' || host.endsWith('.local')) return true;
      // RFC 1918 private ranges
      if (host.startsWith('192.168.') || host.startsWith('10.')) return true;
      // 172.16.0.0/12
      const m = host.match(/^172\.(\d+)\./);
      if (m) { const oct = parseInt(m[1], 10); if (oct >= 16 && oct <= 31) return true; }
      return false;
    } catch {
      return false;
    }
  }, []);

  // Check key status on mount and when dropdown opens
  const checkAllKeys = useCallback(async () => {
    const status: Record<string, boolean> = {};
    const online: Record<string, boolean> = {};
    for (const provider of aiSettings.providers) {
      if (!provider.enabled) {
        status[provider.id] = false;
        online[provider.id] = false;
        continue;
      }
      if (provider.type === 'ollama') {
        status[provider.id] = true; // Ollama doesn't need a key
        try {
          online[provider.id] = await checkLocalProviderOnline(provider.baseUrl, '/api/tags');
        } catch (err) {
          console.warn(`[ModelSelector] Failed to check Ollama (${provider.id}):`, err);
          online[provider.id] = false;
        }
      } else if (provider.type === 'openai_compatible') {
        const isLocal = isLocalUrl(provider.baseUrl);
        if (isLocal) {
          // Local servers (LM Studio etc.) — no auth needed
          status[provider.id] = true;
          try {
            online[provider.id] = await checkLocalProviderOnline(provider.baseUrl, '/models');
          } catch (err) {
            console.warn(`[ModelSelector] Failed to check compatible provider (${provider.id}):`, err);
            online[provider.id] = false;
          }
        } else {
          // Cloud-hosted openai_compatible (Moonshot, DeepSeek, etc.) — needs API key
          try {
            const hasKey = await api.hasAiProviderApiKey(provider.id);
            status[provider.id] = hasKey;
            if (hasKey) {
              const apiKey = await api.getAiProviderApiKey(provider.id);
              const headers = apiKey ? { 'Authorization': `Bearer ${apiKey}` } : undefined;
              online[provider.id] = await checkLocalProviderOnline(provider.baseUrl, '/models', headers);
            } else {
              online[provider.id] = false;
            }
          } catch (err) {
            console.warn(`[ModelSelector] Failed to check compatible provider (${provider.id}):`, err);
            status[provider.id] = false;
            online[provider.id] = false;
          }
        }
      } else {
        try {
          // Only check provider-specific key - no fallback to legacy key for UI display
          status[provider.id] = await api.hasAiProviderApiKey(provider.id);
          online[provider.id] = true;
        } catch {
          status[provider.id] = false;
          online[provider.id] = true;
        }
      }
    }
    setKeyStatus(status);
    setProviderOnline(online);
  }, [aiSettings.providers, checkLocalProviderOnline]);

  // Check on mount so the trigger button indicator is accurate
  useEffect(() => {
    checkAllKeys();
  }, [checkAllKeys]);

  // Re-check when dropdown opens (keys may have changed)
  useEffect(() => {
    if (open) checkAllKeys();
  }, [open, checkAllKeys]);

  // Re-check when API key is updated externally
  useEffect(() => {
    const handleKeyUpdated = () => { checkAllKeys(); };
    window.addEventListener('ai-api-key-updated', handleKeyUpdated);
    return () => window.removeEventListener('ai-api-key-updated', handleKeyUpdated);
  }, [checkAllKeys]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const handleSelect = (provider: AiProvider, model: string) => {
    setActiveProvider(provider.id, model);
    setOpen(false);
  };

  const handleRefresh = async (providerId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (refreshing) return;

    // Guard: check if provider needs a key and doesn't have one
    const provider = aiSettings.providers.find(p => p.id === providerId);
    if (provider && provider.type !== 'ollama'
        && !(provider.type === 'openai_compatible' && isLocalUrl(provider.baseUrl))
        && !keyStatus[providerId]) {
      useToastStore.getState().addToast({
        title: t('ai.model_selector.no_key_warning'),
        variant: 'warning',
      });
      return;
    }

    setRefreshing(providerId);
    try {
      await refreshProviderModels(providerId);
    } catch (err) {
      console.error('[ModelSelector] Failed to refresh models:', err);
    } finally {
      setRefreshing(null);
    }
  };

  // Get compact display name
  const displayName = activeModel
    ? `${activeProvider?.name || 'OxideSens'}/${activeModel.split('/').pop()}`
    : activeProvider?.name || 'OxideSens';

  // Truncate for header space
  const truncatedName = displayName.length > 24 ? displayName.slice(0, 22) + '...' : displayName;

  // If no providers, show a setup prompt
  if (aiSettings.providers.length === 0) {
    return (
      <button
        onClick={onOpenSettings}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium text-amber-400 hover:text-amber-300 hover:bg-amber-400/10"
      >
        <Circle className="w-1.5 h-1.5 fill-current" />
        <span>{t('ai.model_selector.no_provider')}</span>
      </button>
    );
  }

  return (
    <div className="relative min-w-0" ref={dropdownRef}>
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          "flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium min-w-0",
          "text-theme-text-muted hover:text-theme-text hover:bg-theme-accent/10",
          open && "bg-theme-accent/10 text-theme-text"
        )}
        title={`${activeProvider?.name || 'OxideSens'}: ${activeModel}`}
      >
        <Circle className={cn(
          "w-1.5 h-1.5 fill-current shrink-0",
          keyStatus[activeProvider?.id || ''] === true ? "text-emerald-400" : "text-amber-400"
        )} />
        <span className="truncate">{truncatedName}</span>
        <ChevronDown className="w-2.5 h-2.5 shrink-0" />
      </button>

      {open && (
        <div className="absolute left-0 bottom-full mb-0.5 w-64 bg-theme-bg-elevated border border-theme-border rounded-md shadow-lg z-50 overflow-hidden">
          <div className="max-h-80 overflow-y-auto py-1">
            {aiSettings.providers
              .filter((p) => p.enabled)
              .map((provider) => {
                const isLocal = provider.type === 'ollama' || (provider.type === 'openai_compatible' && isLocalUrl(provider.baseUrl));
                const hasKey = isLocal || !!keyStatus[provider.id];
                const isOnline = !isLocal || providerOnline[provider.id] !== false;
                return (
                  <div key={provider.id}>
                    {/* Provider header */}
                    <div className="flex items-center justify-between px-3 py-1.5 bg-theme-bg/50">
                      <span className={cn(
                        "text-[10px] font-bold tracking-wider uppercase",
                        hasKey ? "text-theme-text-muted" : "text-theme-text-muted/50"
                      )}>
                        {provider.name}
                      </span>
                      <div className="flex items-center gap-1.5">
                        {hasKey && isOnline && (
                          <button
                            onClick={(e) => handleRefresh(provider.id, e)}
                            className="p-0.5 text-theme-text-muted hover:text-theme-text"
                            title={t('ai.model_selector.refresh_models')}
                            disabled={refreshing === provider.id}
                          >
                            <RefreshCw className={cn("w-2.5 h-2.5", refreshing === provider.id && "animate-spin")} />
                          </button>
                        )}
                        {isLocal && (
                          <span className={cn(
                            "text-[9px] flex items-center gap-0.5",
                            isOnline ? "text-emerald-400" : "text-theme-text-muted"
                          )}>
                            <Circle className="w-2 h-2 fill-current" />
                            {isOnline ? 'OK' : t('ai.model_selector.offline')}
                          </span>
                        )}
                        {!isLocal && (
                          <span className={cn(
                            "text-[9px] flex items-center gap-0.5",
                            hasKey ? "text-emerald-400" : "text-amber-400"
                          )}>
                            <Key className="w-2.5 h-2.5" />
                            {hasKey ? 'OK' : t('ai.model_selector.no_key')}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* No API key: show configure hint instead of models */}
                    {isLocal && !isOnline ? (
                      <div className="px-3 py-2 text-[10px] text-theme-text-muted italic">
                        {t('ai.model_selector.offline')}
                      </div>
                    ) : !hasKey ? (
                      <button
                        onClick={() => { onOpenSettings?.(); setOpen(false); }}
                        className="w-full px-3 py-2 text-[10px] text-amber-400/80 italic text-left hover:bg-theme-bg-hover"
                      >
                        {t('ai.model_selector.no_key_warning')}
                      </button>
                    ) : provider.models.length === 0 ? (
                      <div className="px-3 py-2 text-[10px] text-theme-text-muted italic">
                        {t('ai.model_selector.refresh_models')}
                      </div>
                    ) : (
                      provider.models.map((model) => {
                        const isActive = provider.id === aiSettings.activeProviderId && model === activeModel;
                        return (
                          <button
                            key={`${provider.id}-${model}`}
                            onClick={() => handleSelect(provider, model)}
                            className={cn(
                              "w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left",
                              "text-theme-text-muted hover:text-theme-text hover:bg-theme-bg-hover"
                            )}
                          >
                            {isActive && <Check className="w-3 h-3 flex-shrink-0" />}
                            <span className={cn("truncate", isActive ? "font-medium" : "", !isActive && "ml-5")}>
                              {model}
                            </span>
                          </button>
                        );
                      })
                    )}
                  </div>
                );
              })}
          </div>

          {/* Footer: settings link */}
          {onOpenSettings && (
            <div className="border-t border-theme-border/30">
              <button
                onClick={() => { onOpenSettings(); setOpen(false); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-theme-text-muted hover:text-theme-text hover:bg-theme-bg-hover"
              >
                <Settings className="w-3 h-3" />
                {t('ai.model_selector.manage_providers')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
