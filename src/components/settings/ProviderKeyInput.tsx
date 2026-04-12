// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useConfirm } from '@/hooks/useConfirm';
import { useToast } from '@/hooks/useToast';
import { api } from '@/lib/api';
import { useSettingsStore } from '@/store/settingsStore';

export const ProviderKeyInput = ({ providerId }: { providerId: string }) => {
    const { t } = useTranslation();
    const { error: toastError } = useToast();
    const { confirm, ConfirmDialog } = useConfirm();
    const refreshProviderModels = useSettingsStore((s) => s.refreshProviderModels);
    const [hasKey, setHasKey] = useState(false);
    const [keyInput, setKeyInput] = useState('');
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        api.hasAiProviderApiKey(providerId)
            .then(setHasKey)
            .catch(() => setHasKey(false));
    }, [providerId]);

    return (
        <div className="grid gap-1">
            <Label className="text-xs text-theme-text-muted">{t('settings_view.ai.api_key')}</Label>
            <div className="flex gap-2">
                {hasKey ? (
                    <div className="flex-1 flex items-center gap-2">
                        <div className="flex-1 h-8 px-2 flex items-center bg-theme-bg-card border border-theme-border/50 rounded text-theme-text-muted text-xs italic">
                            ••••••••••••••••
                        </div>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="text-red-400 hover:text-red-300 hover:bg-red-400/10 h-8 text-xs"
                            onClick={async () => {
                                if (await confirm({ title: t('settings_view.ai.remove_confirm'), variant: 'danger' })) {
                                    try {
                                        await api.deleteAiProviderApiKey(providerId);
                                        setHasKey(false);
                                        window.dispatchEvent(new CustomEvent('ai-api-key-updated'));
                                    } catch (error) {
                                        toastError(t('settings_view.ai.remove_failed', { error }));
                                    }
                                }
                            }}
                        >
                            {t('settings_view.ai.remove')}
                        </Button>
                    </div>
                ) : (
                    <>
                        <Input
                            type="password"
                            placeholder="sk-..."
                            className="flex-1 bg-theme-bg h-8 text-xs"
                            value={keyInput}
                            onChange={(event) => setKeyInput(event.target.value)}
                        />
                        <Button
                            variant="secondary"
                            size="sm"
                            className="h-8 text-xs"
                            disabled={!keyInput.trim() || saving}
                            onClick={async () => {
                                if (!keyInput.trim()) return;
                                setSaving(true);
                                try {
                                    await api.setAiProviderApiKey(providerId, keyInput);
                                    setKeyInput('');
                                    setHasKey(true);
                                    window.dispatchEvent(new CustomEvent('ai-api-key-updated'));
                                    refreshProviderModels(providerId).catch((error) =>
                                        console.warn('[ProviderKeyInput] Auto-fetch models failed:', error),
                                    );
                                } catch (error) {
                                    toastError(t('settings_view.ai.save_failed', { error }));
                                } finally {
                                    setSaving(false);
                                }
                            }}
                        >
                            {saving ? t('settings_view.ai.saving') : t('settings_view.ai.save')}
                        </Button>
                    </>
                )}
            </div>
            {ConfirmDialog}
        </div>
    );
};
