// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderInput, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { useToast } from '@/hooks/useToast';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/appStore';
import type { ConnectionDefaults, ConnectionPoolSettings } from '@/store/settingsStore';
import type { SshHostInfo } from '@/types';

type ConnectionsTabProps = {
    connectionDefaults: ConnectionDefaults;
    updateConnectionDefaults: <K extends keyof ConnectionDefaults>(key: K, value: ConnectionDefaults[K]) => void;
    idleTimeoutSecs: number;
    updateConnectionPool: <K extends keyof ConnectionPoolSettings>(key: K, value: ConnectionPoolSettings[K]) => void;
};

export const ConnectionsTab = ({
    connectionDefaults,
    updateConnectionDefaults,
    idleTimeoutSecs,
    updateConnectionPool,
}: ConnectionsTabProps) => {
    const { t } = useTranslation();
    const { success: toastSuccess, error: toastError } = useToast();
    const [groups, setGroups] = useState<string[]>([]);
    const [newGroup, setNewGroup] = useState('');
    const [sshHosts, setSshHosts] = useState<SshHostInfo[]>([]);
    const [selectedSshHosts, setSelectedSshHosts] = useState<Set<string>>(new Set());
    const [batchImporting, setBatchImporting] = useState(false);

    useEffect(() => {
        let cancelled = false;

        api.getGroups()
            .then((result) => {
                if (!cancelled) setGroups(result);
            })
            .catch((error) => {
                console.error('Failed to load groups:', error);
                if (!cancelled) setGroups([]);
            });

        api.listSshConfigHosts()
            .then((result) => {
                if (!cancelled) setSshHosts(result);
            })
            .catch((error) => {
                console.error('Failed to load SSH hosts:', error);
                if (!cancelled) setSshHosts([]);
            });

        return () => {
            cancelled = true;
        };
    }, []);

    const refreshGroups = async () => {
        setGroups(await api.getGroups());
    };

    const refreshHosts = async () => {
        setSshHosts(await api.listSshConfigHosts());
    };

    const handleCreateGroup = async () => {
        if (!newGroup.trim()) return;
        try {
            await api.createGroup(newGroup.trim());
            setNewGroup('');
            await refreshGroups();
        } catch (error) {
            console.error('Failed to create group:', error);
            toastError(t('settings_view.errors.create_group_failed', { error }));
        }
    };

    const handleDeleteGroup = async (name: string) => {
        try {
            await api.deleteGroup(name);
            await refreshGroups();
        } catch (error) {
            console.error('Failed to delete group:', error);
            toastError(t('settings_view.errors.delete_group_failed', { error }));
        }
    };

    const handleImportHost = async (alias: string) => {
        try {
            const imported = await api.importSshHost(alias);
            toastSuccess(t('settings_view.errors.import_success', { name: imported.name }));
            await refreshHosts();
            setSelectedSshHosts((previous) => {
                const next = new Set(previous);
                next.delete(alias);
                return next;
            });
            await useAppStore.getState().loadSavedConnections();
        } catch (error) {
            console.error('Failed to import SSH host:', error);
            toastError(t('settings_view.errors.import_failed', { error }));
        }
    };

    const handleBatchImportHosts = async () => {
        if (selectedSshHosts.size === 0) return;
        setBatchImporting(true);
        try {
            const result = await api.importSshHosts(Array.from(selectedSshHosts));
            const parts: string[] = [];
            if (result.imported > 0) parts.push(t('settings_view.connections.ssh_config.batch_import_success', { count: result.imported }));
            if (result.skipped > 0) parts.push(t('settings_view.connections.ssh_config.batch_import_skipped', { count: result.skipped }));
            if (result.errors.length > 0) parts.push(result.errors.join(', '));

            if (result.imported > 0 || result.skipped > 0) {
                toastSuccess(parts.join(' · '));
                await refreshHosts();
                setSelectedSshHosts(new Set());
                await useAppStore.getState().loadSavedConnections();
            } else if (result.errors.length > 0) {
                toastError(parts.join(' · '));
            }
        } catch (error) {
            console.error('Batch import failed:', error);
            toastError(t('settings_view.errors.import_failed', { error }));
        } finally {
            setBatchImporting(false);
        }
    };

    const toggleSshHost = (alias: string) => {
        setSelectedSshHosts((previous) => {
            const next = new Set(previous);
            if (next.has(alias)) next.delete(alias);
            else next.add(alias);
            return next;
        });
    };

    const toggleAllSshHosts = () => {
        const importable = sshHosts.filter((host) => !host.already_imported);
        const allSelected = importable.length > 0 && importable.every((host) => selectedSshHosts.has(host.alias));
        if (allSelected) {
            setSelectedSshHosts(new Set());
            return;
        }
        setSelectedSshHosts(new Set(importable.map((host) => host.alias)));
    };

    return (
        <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div>
                <h3 className="text-2xl font-medium text-theme-text-heading mb-2">{t('settings_view.connections.title')}</h3>
                <p className="text-theme-text-muted">{t('settings_view.connections.description')}</p>
            </div>
            <Separator />

            <div className="grid grid-cols-2 gap-8 max-w-2xl">
                <div className="grid gap-2">
                    <Label>{t('settings_view.connections.default_username')}</Label>
                    <Input value={connectionDefaults.username} onChange={(event) => updateConnectionDefaults('username', event.target.value)} />
                </div>
                <div className="grid gap-2">
                    <Label>{t('settings_view.connections.default_port')}</Label>
                    <Input value={connectionDefaults.port} onChange={(event) => updateConnectionDefaults('port', parseInt(event.target.value, 10) || 22)} />
                </div>
            </div>

            <div className="pt-8">
                <h3 className="text-xl font-medium text-theme-text-heading mb-2">{t('settings_view.connections.groups.title')}</h3>
                <p className="text-sm text-theme-text-muted mb-4">{t('settings_view.connections.groups.description')}</p>
                <Separator className="mb-4" />

                <div className="flex gap-2 mb-4 max-w-md">
                    <Input placeholder={t('settings_view.connections.groups.new_placeholder')} value={newGroup} onChange={(event) => setNewGroup(event.target.value)} />
                    <Button onClick={handleCreateGroup} disabled={!newGroup}>
                        <Plus className="h-4 w-4 mr-1" /> {t('settings_view.connections.groups.add')}
                    </Button>
                </div>

                <div className="space-y-2 max-w-md">
                    {groups.map((group) => (
                        <div key={group} className="flex items-center justify-between p-3 bg-theme-bg-panel rounded-md border border-theme-border">
                            <span className="text-sm">{group}</span>
                            <Button size="icon" variant="ghost" className="h-8 w-8 text-theme-text-muted hover:text-red-400" onClick={() => handleDeleteGroup(group)}>
                                <Trash2 className="h-4 w-4" />
                            </Button>
                        </div>
                    ))}
                </div>
            </div>

            <div className="pt-8">
                <h3 className="text-xl font-medium text-theme-text-heading mb-2">{t('settings_view.connections.idle_timeout.title')}</h3>
                <p className="text-sm text-theme-text-muted mb-4">{t('settings_view.connections.idle_timeout.description')}</p>
                <Separator className="mb-4" />
                <div className="grid gap-2 max-w-xs">
                    <Label>{t('settings_view.connections.idle_timeout.label')}</Label>
                    <Select
                        value={String(idleTimeoutSecs)}
                        onValueChange={(value) => {
                            try {
                                updateConnectionPool('idleTimeoutSecs', parseInt(value, 10));
                            } catch (error) {
                                console.error('Failed to update pool config:', error);
                                toastError(t('settings_view.connections.idle_timeout.save_failed'));
                            }
                        }}
                    >
                        <SelectTrigger className="w-full">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="300">{t('settings_view.connections.idle_timeout.5min')}</SelectItem>
                            <SelectItem value="900">{t('settings_view.connections.idle_timeout.15min')}</SelectItem>
                            <SelectItem value="1800">{t('settings_view.connections.idle_timeout.30min')}</SelectItem>
                            <SelectItem value="3600">{t('settings_view.connections.idle_timeout.1hr')}</SelectItem>
                            <SelectItem value="0">{t('settings_view.connections.idle_timeout.never')}</SelectItem>
                        </SelectContent>
                    </Select>
                    <p className="text-xs text-theme-text-muted">{t('settings_view.connections.idle_timeout.hint')}</p>
                </div>
            </div>

            <div className="pt-8">
                <h3 className="text-xl font-medium text-theme-text-heading mb-2">{t('settings_view.connections.ssh_config.title')}</h3>
                <p className="text-sm text-theme-text-muted mb-4">{t('settings_view.connections.ssh_config.description')}</p>
                <Separator className="mb-4" />

                {sshHosts.length > 0 && (
                    <div className="flex items-center justify-between mb-2 max-w-2xl">
                        <button type="button" onClick={toggleAllSshHosts} className="text-xs text-theme-accent hover:text-theme-accent-hover transition-colors">
                            {sshHosts.filter((host) => !host.already_imported).length > 0 && sshHosts.filter((host) => !host.already_imported).every((host) => selectedSshHosts.has(host.alias))
                                ? t('settings_view.connections.ssh_config.deselect_all')
                                : t('settings_view.connections.ssh_config.select_all')}
                        </button>
                        {selectedSshHosts.size > 0 && (
                            <Button size="sm" variant="secondary" onClick={handleBatchImportHosts} disabled={batchImporting} className="h-7 text-xs">
                                <FolderInput className="h-3.5 w-3.5 mr-1" />
                                {batchImporting
                                    ? t('settings_view.connections.ssh_config.importing')
                                    : t('settings_view.connections.ssh_config.import_selected', { count: selectedSshHosts.size })}
                            </Button>
                        )}
                    </div>
                )}

                <div className="h-64 overflow-y-auto border border-theme-border rounded-md bg-theme-bg-panel p-2 max-w-2xl">
                    {sshHosts.map((host) => (
                        <div
                            key={host.alias}
                            className={cn(
                                'flex items-center justify-between p-3 rounded-md border mb-1',
                                host.already_imported
                                    ? 'opacity-50 border-transparent'
                                    : 'hover:bg-theme-bg-hover border-transparent hover:border-theme-border',
                            )}
                        >
                            <div className="flex items-center gap-2 flex-1 cursor-pointer" onClick={() => !host.already_imported && toggleSshHost(host.alias)}>
                                <Checkbox
                                    checked={selectedSshHosts.has(host.alias)}
                                    disabled={host.already_imported}
                                    onCheckedChange={() => !host.already_imported && toggleSshHost(host.alias)}
                                    className="border-theme-text-muted data-[state=checked]:bg-theme-accent data-[state=checked]:border-theme-accent"
                                />
                                <div className="flex flex-col">
                                    <div className="flex items-center gap-2">
                                        <span className="text-sm font-medium">{host.alias}</span>
                                        {host.already_imported && (
                                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-theme-accent/20 text-theme-accent">
                                                {t('settings_view.connections.ssh_config.already_imported')}
                                            </span>
                                        )}
                                    </div>
                                    <span className="text-xs text-theme-text-muted">{host.user}@{host.hostname}:{host.port}</span>
                                </div>
                            </div>
                            <Button size="sm" variant="secondary" onClick={() => handleImportHost(host.alias)} disabled={host.already_imported}>
                                <FolderInput className="h-4 w-4 mr-1" /> {t('settings_view.connections.ssh_config.import')}
                            </Button>
                        </div>
                    ))}
                    {sshHosts.length === 0 && (
                        <div className="text-center py-12 text-theme-text-muted text-sm">
                            {t('settings_view.connections.ssh_config.no_hosts')}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};