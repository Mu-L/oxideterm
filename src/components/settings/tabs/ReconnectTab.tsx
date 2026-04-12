// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import { useTranslation } from 'react-i18next';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import type { ReconnectSettings } from '@/store/settingsStore';

type ReconnectTabProps = {
    reconnect?: ReconnectSettings;
    updateReconnect: <K extends keyof ReconnectSettings>(key: K, value: ReconnectSettings[K]) => void;
};

export const ReconnectTab = ({ reconnect, updateReconnect }: ReconnectTabProps) => {
    const { t } = useTranslation();

    return (
        <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div>
                <h3 className="text-2xl font-medium text-theme-text-heading mb-2">{t('settings_view.reconnect.title')}</h3>
                <p className="text-theme-text-muted">{t('settings_view.reconnect.description')}</p>
            </div>
            <Separator />

            <div className="flex items-center justify-between max-w-2xl">
                <div className="grid gap-1">
                    <Label>{t('settings_view.reconnect.enabled')}</Label>
                    <p className="text-xs text-theme-text-muted">{t('settings_view.reconnect.enabled_hint')}</p>
                </div>
                <Checkbox checked={reconnect?.enabled ?? true} onCheckedChange={(checked) => updateReconnect('enabled', !!checked)} />
            </div>

            <Separator />

            <div className={cn('space-y-6 transition-opacity', !(reconnect?.enabled ?? true) && 'opacity-40 pointer-events-none')}>
                <h4 className="text-lg font-medium text-theme-text-heading">{t('settings_view.reconnect.strategy')}</h4>

                <div className="grid grid-cols-2 gap-8 max-w-2xl">
                    <div className="grid gap-2">
                        <Label>{t('settings_view.reconnect.max_attempts')}</Label>
                        <p className="text-xs text-theme-text-muted">{t('settings_view.reconnect.max_attempts_hint')}</p>
                        <Select value={String(reconnect?.maxAttempts ?? 5)} onValueChange={(value) => updateReconnect('maxAttempts', parseInt(value, 10))}>
                            <SelectTrigger className="w-full">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {[1, 2, 3, 5, 8, 10, 15, 20].map((attempts) => (
                                    <SelectItem key={attempts} value={String(attempts)}>{attempts}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="grid gap-2">
                        <Label>{t('settings_view.reconnect.base_delay')}</Label>
                        <p className="text-xs text-theme-text-muted">{t('settings_view.reconnect.base_delay_hint')}</p>
                        <Select value={String(reconnect?.baseDelayMs ?? 1000)} onValueChange={(value) => updateReconnect('baseDelayMs', parseInt(value, 10))}>
                            <SelectTrigger className="w-full">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {[
                                    { value: 500, label: '0.5s' },
                                    { value: 1000, label: '1s' },
                                    { value: 2000, label: '2s' },
                                    { value: 3000, label: '3s' },
                                    { value: 5000, label: '5s' },
                                    { value: 10000, label: '10s' },
                                ].map(({ value, label }) => (
                                    <SelectItem key={value} value={String(value)}>{label}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                </div>

                <div className="grid grid-cols-2 gap-8 max-w-2xl">
                    <div className="grid gap-2">
                        <Label>{t('settings_view.reconnect.max_delay')}</Label>
                        <p className="text-xs text-theme-text-muted">{t('settings_view.reconnect.max_delay_hint')}</p>
                        <Select value={String(reconnect?.maxDelayMs ?? 15000)} onValueChange={(value) => updateReconnect('maxDelayMs', parseInt(value, 10))}>
                            <SelectTrigger className="w-full">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {[
                                    { value: 5000, label: '5s' },
                                    { value: 10000, label: '10s' },
                                    { value: 15000, label: '15s' },
                                    { value: 30000, label: '30s' },
                                    { value: 60000, label: '60s' },
                                ].map(({ value, label }) => (
                                    <SelectItem key={value} value={String(value)}>{label}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                </div>

                <div className="p-4 bg-theme-bg-card border border-theme-border/50 rounded-md max-w-2xl">
                    <p className="text-xs text-theme-text-muted leading-relaxed">
                        {t('settings_view.reconnect.formula_hint')}
                    </p>
                </div>
            </div>
        </div>
    );
};