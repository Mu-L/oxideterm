// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import { useCallback, useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import { FileKey, Key, Pencil, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { api } from '@/lib/api';
import type { ManagedSshKeyInfo, ManagedSshKeyUsage, SshKeyInfo } from '@/types';

type DeleteCandidate = {
    key: ManagedSshKeyInfo;
    usage: ManagedSshKeyUsage;
};

export const SshTab = () => {
    const { t } = useTranslation();
    const [keys, setKeys] = useState<SshKeyInfo[]>([]);
    const [managedKeys, setManagedKeys] = useState<ManagedSshKeyInfo[]>([]);
    const [usageByKeyId, setUsageByKeyId] = useState<Record<string, ManagedSshKeyUsage>>({});
    const [loadingManagedKeys, setLoadingManagedKeys] = useState(false);
    const [managedError, setManagedError] = useState('');
    const [fileDialogOpen, setFileDialogOpen] = useState(false);
    const [pasteDialogOpen, setPasteDialogOpen] = useState(false);
    const [renameKey, setRenameKey] = useState<ManagedSshKeyInfo | null>(null);
    const [deleteCandidate, setDeleteCandidate] = useState<DeleteCandidate | null>(null);
    const [busy, setBusy] = useState(false);
    const [filePath, setFilePath] = useState('');
    const [fileName, setFileName] = useState('');
    const [filePassphrase, setFilePassphrase] = useState('');
    const [pasteName, setPasteName] = useState('');
    const [pastedPrivateKey, setPastedPrivateKey] = useState('');
    const [pastePassphrase, setPastePassphrase] = useState('');
    const [renameDraft, setRenameDraft] = useState('');

    const refreshManagedKeys = useCallback(async () => {
        setLoadingManagedKeys(true);
        setManagedError('');
        try {
            const nextKeys = await api.listManagedSshKeys();
            const usageEntries = await Promise.all(
                nextKeys.map(async (key) => [key.id, await api.getManagedSshKeyUsage(key.id)] as const),
            );
            setManagedKeys(nextKeys);
            setUsageByKeyId(Object.fromEntries(usageEntries));
        } catch (error) {
            setManagedError(error instanceof Error ? error.message : String(error));
            setManagedKeys([]);
            setUsageByKeyId({});
        } finally {
            setLoadingManagedKeys(false);
        }
    }, []);

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

    useEffect(() => {
        void refreshManagedKeys();
    }, [refreshManagedKeys]);

    const resetFileDraft = () => {
        setFilePath('');
        setFileName('');
        setFilePassphrase('');
    };

    const resetPasteDraft = () => {
        setPasteName('');
        setPastedPrivateKey('');
        setPastePassphrase('');
    };

    const handleBrowseImportFile = async () => {
        const selected = await open({
            multiple: false,
            directory: false,
            title: t('modals.managed_key.import_file.browse_title'),
            defaultPath: '~/.ssh',
        });
        if (typeof selected === 'string') {
            setFilePath(selected);
            setFileName(selected.split(/[\\/]/).pop() ?? '');
        }
    };

    const handleImportFile = async () => {
        if (!filePath.trim()) return;
        setBusy(true);
        setManagedError('');
        try {
            await api.createManagedSshKeyFromFile(
                filePath.trim(),
                fileName.trim() || undefined,
                filePassphrase || undefined,
            );
            setFileDialogOpen(false);
            resetFileDraft();
            await refreshManagedKeys();
        } catch (error) {
            setManagedError(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy(false);
        }
    };

    const handlePasteImport = async () => {
        if (!pastedPrivateKey.trim()) return;
        setBusy(true);
        setManagedError('');
        try {
            // Submit the private-key draft only at the explicit import boundary.
            await api.createManagedSshKeyFromText(
                pastedPrivateKey,
                pasteName.trim() || undefined,
                pastePassphrase || undefined,
            );
            setPasteDialogOpen(false);
            resetPasteDraft();
            await refreshManagedKeys();
        } catch (error) {
            setManagedError(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy(false);
        }
    };

    const openRenameDialog = (key: ManagedSshKeyInfo) => {
        setRenameKey(key);
        setRenameDraft(key.name);
    };

    const handleRename = async () => {
        if (!renameKey || !renameDraft.trim()) return;
        setBusy(true);
        setManagedError('');
        try {
            await api.renameManagedSshKey(renameKey.id, renameDraft.trim());
            setRenameKey(null);
            setRenameDraft('');
            await refreshManagedKeys();
        } catch (error) {
            setManagedError(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy(false);
        }
    };

    const openDeleteDialog = async (key: ManagedSshKeyInfo) => {
        setBusy(true);
        setManagedError('');
        try {
            const usage = await api.getManagedSshKeyUsage(key.id);
            setDeleteCandidate({ key, usage });
        } catch (error) {
            setManagedError(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy(false);
        }
    };

    const handleDeleteUnusedKey = async () => {
        if (!deleteCandidate || deleteCandidate.usage.count > 0) return;
        setBusy(true);
        setManagedError('');
        try {
            await api.deleteManagedSshKey(deleteCandidate.key.id, false);
            setDeleteCandidate(null);
            await refreshManagedKeys();
        } catch (error) {
            setManagedError(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy(false);
        }
    };

    const formatOrigin = (origin: ManagedSshKeyInfo['origin']) => {
        switch (origin) {
            case 'imported_file':
                return t('settings_view.ssh_keys.origin_imported_file');
            case 'pasted_text':
                return t('settings_view.ssh_keys.origin_pasted_text');
            case 'oxide_import':
                return t('settings_view.ssh_keys.origin_oxide_import');
            default:
                return origin;
        }
    };

    return (
        <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div>
                <h3 className="text-2xl font-medium text-theme-text-heading mb-2">{t('settings_view.ssh_keys.title')}</h3>
                <p className="text-theme-text-muted">{t('settings_view.ssh_keys.description')}</p>
            </div>
            <Separator />

            <div className="space-y-3 max-w-3xl">
                <div>
                    <h4 className="text-lg font-medium text-theme-text">{t('settings_view.ssh_keys.local_section')}</h4>
                    <p className="text-sm text-theme-text-muted">{t('settings_view.ssh_keys.local_description')}</p>
                </div>
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

            <div className="space-y-3 max-w-5xl">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <h4 className="text-lg font-medium text-theme-text">{t('settings_view.ssh_keys.managed_section')}</h4>
                        <p className="text-sm text-theme-text-muted">{t('settings_view.ssh_keys.managed_description')}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <Button type="button" variant="outline" size="sm" onClick={() => setFileDialogOpen(true)}>
                            <FileKey className="mr-2 h-4 w-4" />
                            {t('settings_view.ssh_keys.import_file')}
                        </Button>
                        <Button type="button" variant="outline" size="sm" onClick={() => setPasteDialogOpen(true)}>
                            <ShieldCheck className="mr-2 h-4 w-4" />
                            {t('settings_view.ssh_keys.paste_key')}
                        </Button>
                        <Button type="button" variant="ghost" size="sm" onClick={() => void refreshManagedKeys()} disabled={loadingManagedKeys}>
                            <RefreshCw className="mr-2 h-4 w-4" />
                            {t('settings_view.ssh_keys.refresh')}
                        </Button>
                    </div>
                </div>

                {managedError && (
                    <div className="rounded-md border border-red-900/50 bg-red-900/20 px-3 py-2 text-sm text-red-300">
                        {managedError}
                    </div>
                )}

                {managedKeys.map((key) => {
                    const usage = usageByKeyId[key.id]?.count ?? 0;
                    return (
                        <div key={key.id} className="flex flex-wrap items-center justify-between gap-4 p-4 bg-theme-bg-panel border border-theme-border rounded-md">
                            <div className="flex min-w-0 items-center gap-4">
                                <div className="p-2 bg-theme-bg rounded-full">
                                    <ShieldCheck className="h-5 w-5 text-theme-accent" />
                                </div>
                                <div className="min-w-0 flex flex-col gap-1">
                                    <span className="text-sm font-medium text-theme-text">{key.name}</span>
                                    <span className="truncate font-mono text-xs text-theme-text-muted">{key.fingerprint}</span>
                                    <span className="text-xs text-theme-text-muted">
                                        {formatOrigin(key.origin)} · {key.requires_passphrase ? t('settings_view.ssh_keys.passphrase_required') : t('settings_view.ssh_keys.passphrase_not_required')} · {t('settings_view.ssh_keys.used_by', { count: usage })}
                                    </span>
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <Button type="button" variant="ghost" size="sm" onClick={() => openRenameDialog(key)}>
                                    <Pencil className="mr-2 h-4 w-4" />
                                    {t('settings_view.ssh_keys.rename')}
                                </Button>
                                <Button type="button" variant="ghost" size="sm" onClick={() => void openDeleteDialog(key)} disabled={busy}>
                                    <Trash2 className="mr-2 h-4 w-4" />
                                    {t('settings_view.ssh_keys.delete')}
                                </Button>
                            </div>
                        </div>
                    );
                })}

                {!loadingManagedKeys && managedKeys.length === 0 && (
                    <div className="text-center py-12 text-theme-text-muted border border-dashed border-theme-border rounded-md">
                        {t('settings_view.ssh_keys.no_managed_keys')}
                    </div>
                )}
            </div>

            <Dialog open={fileDialogOpen} onOpenChange={(open) => {
                setFileDialogOpen(open);
                if (!open) resetFileDraft();
            }}>
                <DialogContent className="sm:max-w-[520px]">
                    <DialogHeader>
                        <DialogTitle>{t('modals.managed_key.import_file.title')}</DialogTitle>
                        <DialogDescription>{t('modals.managed_key.import_file.description')}</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 p-4">
                        <div className="space-y-2">
                            <Label>{t('modals.managed_key.display_name')}</Label>
                            <Input value={fileName} onChange={(event) => setFileName(event.target.value)} />
                        </div>
                        <div className="space-y-2">
                            <Label>{t('modals.managed_key.import_file.path')}</Label>
                            <div className="flex gap-2">
                                <Input value={filePath} onChange={(event) => setFilePath(event.target.value)} />
                                <Button type="button" variant="outline" onClick={handleBrowseImportFile}>
                                    {t('modals.new_connection.browse')}
                                </Button>
                            </div>
                        </div>
                        <div className="space-y-2">
                            <Label>{t('modals.managed_key.passphrase')}</Label>
                            <Input
                                type="password"
                                value={filePassphrase}
                                onChange={(event) => setFilePassphrase(event.target.value)}
                                placeholder={t('modals.managed_key.passphrase_placeholder')}
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={() => setFileDialogOpen(false)}>
                            {t('modals.managed_key.cancel')}
                        </Button>
                        <Button type="button" onClick={handleImportFile} disabled={!filePath.trim() || busy}>
                            {busy ? t('modals.managed_key.importing') : t('modals.managed_key.import')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={pasteDialogOpen} onOpenChange={(open) => {
                setPasteDialogOpen(open);
                if (!open) resetPasteDraft();
            }}>
                <DialogContent className="sm:max-w-[560px]">
                    <DialogHeader>
                        <DialogTitle>{t('modals.managed_key.paste.title')}</DialogTitle>
                        <DialogDescription>{t('modals.managed_key.paste.description')}</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 p-4">
                        <div className="space-y-2">
                            <Label>{t('modals.managed_key.display_name')}</Label>
                            <Input value={pasteName} onChange={(event) => setPasteName(event.target.value)} />
                        </div>
                        <div className="space-y-2">
                            <Label>{t('modals.managed_key.paste.private_key')}</Label>
                            <textarea
                                value={pastedPrivateKey}
                                onChange={(event) => setPastedPrivateKey(event.target.value)}
                                spellCheck={false}
                                className="min-h-48 w-full resize-y rounded-md border border-theme-border/50 bg-theme-bg/50 px-3 py-2 font-mono text-sm text-theme-text outline-none placeholder:text-theme-text-muted focus-visible:border-theme-accent focus-visible:ring-1 focus-visible:ring-theme-accent"
                                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label>{t('modals.managed_key.passphrase')}</Label>
                            <Input
                                type="password"
                                value={pastePassphrase}
                                onChange={(event) => setPastePassphrase(event.target.value)}
                                placeholder={t('modals.managed_key.passphrase_placeholder')}
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={() => setPasteDialogOpen(false)}>
                            {t('modals.managed_key.cancel')}
                        </Button>
                        <Button type="button" onClick={handlePasteImport} disabled={!pastedPrivateKey.trim() || busy}>
                            {busy ? t('modals.managed_key.importing') : t('modals.managed_key.import')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={Boolean(renameKey)} onOpenChange={(open) => {
                if (!open) setRenameKey(null);
            }}>
                <DialogContent className="sm:max-w-[420px]">
                    <DialogHeader>
                        <DialogTitle>{t('settings_view.ssh_keys.rename_title')}</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-2 p-4">
                        <Label>{t('settings_view.ssh_keys.rename_name')}</Label>
                        <Input value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)} />
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={() => setRenameKey(null)}>
                            {t('modals.managed_key.cancel')}
                        </Button>
                        <Button type="button" onClick={handleRename} disabled={!renameDraft.trim() || busy}>
                            {t('settings_view.ssh_keys.rename')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={Boolean(deleteCandidate)} onOpenChange={(open) => {
                if (!open) setDeleteCandidate(null);
            }}>
                <DialogContent className="sm:max-w-[520px]">
                    <DialogHeader>
                        <DialogTitle>{t('settings_view.ssh_keys.delete_title')}</DialogTitle>
                        <DialogDescription>
                            {deleteCandidate?.usage.count
                                ? t('settings_view.ssh_keys.delete_blocked_description', { count: deleteCandidate.usage.count })
                                : t('settings_view.ssh_keys.delete_unused_description')}
                        </DialogDescription>
                    </DialogHeader>
                    {deleteCandidate && deleteCandidate.usage.items.length > 0 && (
                        <div className="max-h-56 space-y-2 overflow-auto p-4">
                            {deleteCandidate.usage.items.map((item, index) => (
                                <div key={`${item.connection_id}-${item.location}-${index}`} className="rounded-md border border-theme-border bg-theme-bg/50 px-3 py-2 text-sm">
                                    <p className="font-medium text-theme-text">{item.connection_name}</p>
                                    <p className="text-xs text-theme-text-muted">{item.location}</p>
                                </div>
                            ))}
                        </div>
                    )}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={() => setDeleteCandidate(null)}>
                            {deleteCandidate?.usage.count ? t('settings_view.ssh_keys.close') : t('modals.managed_key.cancel')}
                        </Button>
                        {deleteCandidate && deleteCandidate.usage.count === 0 && (
                            <Button type="button" variant="destructive" onClick={handleDeleteUnusedKey} disabled={busy}>
                                {t('settings_view.ssh_keys.delete')}
                            </Button>
                        )}
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
};
