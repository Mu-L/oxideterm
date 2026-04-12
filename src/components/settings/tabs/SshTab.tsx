// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Key } from 'lucide-react';
import { Separator } from '@/components/ui/separator';
import { api } from '@/lib/api';
import type { SshKeyInfo } from '@/types';

export const SshTab = () => {
    const { t } = useTranslation();
    const [keys, setKeys] = useState<SshKeyInfo[]>([]);

    useEffect(() => {
        let cancelled = false;
        api.checkSshKeys()
            .then((result) => {
                if (!cancelled) setKeys(result);
            })
            .catch((error) => {
                console.error('Failed to load SSH keys:', error);
                if (!cancelled) setKeys([]);
            });

        return () => {
            cancelled = true;
        };
    }, []);

    return (
        <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div>
                <h3 className="text-2xl font-medium text-theme-text-heading mb-2">{t('settings_view.ssh_keys.title')}</h3>
                <p className="text-theme-text-muted">{t('settings_view.ssh_keys.description')}</p>
            </div>
            <Separator />

            <div className="space-y-3 max-w-3xl">
                {keys.map((key) => (
                    <div key={key.name} className="flex items-center justify-between p-4 bg-theme-bg-panel border border-theme-border rounded-md">
                        <div className="flex items-center gap-4">
                            <div className="p-2 bg-theme-bg rounded-full">
                                <Key className="h-5 w-5 text-theme-accent" />
                            </div>
                            <div className="flex flex-col">
                                <span className="text-sm font-medium text-theme-text">{key.name}</span>
                                <span className="text-xs text-theme-text-muted">{key.key_type} · {key.path}</span>
                            </div>
                        </div>
                        {key.has_passphrase && (
                            <span className="text-xs bg-yellow-900/30 text-yellow-500 px-2 py-1 rounded border border-yellow-900/50">{t('settings_view.ssh_keys.encrypted')}</span>
                        )}
                    </div>
                ))}
                {keys.length === 0 && (
                    <div className="text-center py-12 text-theme-text-muted border border-dashed border-theme-border rounded-md">
                        {t('settings_view.ssh_keys.no_keys')}
                    </div>
                )}
            </div>
        </div>
    );
};