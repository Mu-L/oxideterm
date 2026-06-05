// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyRound, Plus, Save as SaveIcon, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { api } from '@/lib/api';
import { platform } from '@/lib/platform';
import { useLocalTerminalStore } from '@/store/localTerminalStore';
import { useSettingsStore } from '@/store/settingsStore';
import type { PrivilegeCredentialKind, SavedPrivilegeCredential, ShellInfo } from '@/types';

const GIT_BASH_ID = 'git-bash';
const LOCAL_SHELL_PRIVILEGE_CONNECTION_ID = 'local-shell:default';

type PrivilegeCredentialDraft = {
    credentialId: string | null;
    label: string;
    kind: PrivilegeCredentialKind;
    usernameHint: string;
    promptPatterns: string;
    secret: string;
    enabled: boolean;
};

const EMPTY_PRIVILEGE_DRAFT: PrivilegeCredentialDraft = {
    credentialId: null,
    label: '',
    kind: 'sudo_password',
    usernameHint: '',
    promptPatterns: '',
    secret: '',
    enabled: true,
};

function withGitBashOverride(shells: ShellInfo[], gitBashPath: string | null | undefined): ShellInfo[] {
    const path = gitBashPath?.trim();
    if (!path) return shells;

    return [
        ...shells.filter((shell) => shell.id !== GIT_BASH_ID),
        {
            id: GIT_BASH_ID,
            label: 'Git Bash',
            path,
            args: ['--login'],
        },
    ];
}

export const LocalTerminalSettings = () => {
    const { t } = useTranslation();
    const { shells, loadShells, shellsLoaded } = useLocalTerminalStore();
    const { settings, updateLocalTerminal } = useSettingsStore();
    const localSettings = settings.localTerminal;
    const [privilegeCredentials, setPrivilegeCredentials] = useState<SavedPrivilegeCredential[]>([]);
    const [privilegeDraft, setPrivilegeDraft] = useState<PrivilegeCredentialDraft>(EMPTY_PRIVILEGE_DRAFT);
    const [privilegeSaving, setPrivilegeSaving] = useState(false);
    const [privilegeError, setPrivilegeError] = useState('');
    const privilegeSectionRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!shellsLoaded) {
            loadShells();
        }
    }, [shellsLoaded, loadShells]);

    const defaultShellId = localSettings?.defaultShellId;
    const effectiveShells = withGitBashOverride(shells, localSettings?.gitBashPath);
    const defaultShell = effectiveShells.find((shell) => shell.id === defaultShellId) || effectiveShells[0];

    useEffect(() => {
        let cancelled = false;
        api.listPrivilegeCredentials(LOCAL_SHELL_PRIVILEGE_CONNECTION_ID)
            .then((credentials) => {
                if (!cancelled) setPrivilegeCredentials(credentials);
            })
            .catch((error) => {
                if (!cancelled) {
                    console.error('[LocalTerminalSettings] Failed to load local privilege credentials:', error);
                    setPrivilegeCredentials([]);
                }
            });
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        const handleFocusSettingsSection = (event: Event) => {
            const detail = (event as CustomEvent<{ tab?: string; section?: string }>).detail;
            if (detail?.tab !== 'local' || detail.section !== 'privilege-credentials') {
                return;
            }
            privilegeSectionRef.current?.scrollIntoView({ block: 'center' });
        };
        window.addEventListener('oxideterm:focus-settings-section', handleFocusSettingsSection);
        return () => window.removeEventListener('oxideterm:focus-settings-section', handleFocusSettingsSection);
    }, []);

    const resetPrivilegeDraft = () => {
        setPrivilegeDraft(EMPTY_PRIVILEGE_DRAFT);
        setPrivilegeError('');
    };

    const startEditPrivilegeCredential = (credential: SavedPrivilegeCredential) => {
        setPrivilegeDraft({
            credentialId: credential.id,
            label: credential.label,
            kind: credential.kind,
            usernameHint: credential.username_hint ?? '',
            promptPatterns: credential.prompt_patterns.join('\n'),
            secret: '',
            enabled: credential.enabled,
        });
        setPrivilegeError('');
    };

    const handleSavePrivilegeCredential = async () => {
        const label = privilegeDraft.label.trim();
        if (!label) return;

        setPrivilegeSaving(true);
        setPrivilegeError('');
        try {
            // Local shell credentials have no SSH connection owner. They use a
            // dedicated scope so local sudo/su secrets cannot be confused with
            // saved connection authentication material.
            const saved = await api.savePrivilegeCredential({
                connectionId: LOCAL_SHELL_PRIVILEGE_CONNECTION_ID,
                credentialId: privilegeDraft.credentialId,
                label,
                kind: privilegeDraft.kind,
                usernameHint: privilegeDraft.usernameHint.trim() || null,
                promptPatterns: privilegeDraft.promptPatterns
                    .split(/\r?\n/)
                    .map((pattern) => pattern.trim())
                    .filter(Boolean),
                secret: privilegeDraft.secret || null,
                enabled: privilegeDraft.enabled,
                requireClickToSend: true,
            });
            setPrivilegeCredentials((current) => {
                const index = current.findIndex((candidate) => candidate.id === saved.id);
                if (index === -1) return [...current, saved];
                const next = [...current];
                next[index] = saved;
                return next;
            });
            resetPrivilegeDraft();
        } catch (error) {
            console.error('[LocalTerminalSettings] Failed to save local privilege credential:', error);
            setPrivilegeError(error instanceof Error ? error.message : String(error));
        } finally {
            setPrivilegeSaving(false);
        }
    };

    const handleDeletePrivilegeCredential = async (credential: SavedPrivilegeCredential) => {
        setPrivilegeError('');
        try {
            await api.deletePrivilegeCredential(LOCAL_SHELL_PRIVILEGE_CONNECTION_ID, credential.id);
            setPrivilegeCredentials((current) => current.filter((candidate) => candidate.id !== credential.id));
            if (privilegeDraft.credentialId === credential.id) {
                resetPrivilegeDraft();
            }
        } catch (error) {
            console.error('[LocalTerminalSettings] Failed to delete local privilege credential:', error);
            setPrivilegeError(error instanceof Error ? error.message : String(error));
        }
    };

    return (
        <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div>
                <h3 className="text-2xl font-medium text-theme-text-heading mb-2">{t('settings_view.local_terminal.title')}</h3>
                <p className="text-theme-text-muted">{t('settings_view.local_terminal.description')}</p>
            </div>
            <Separator />

            <div
                ref={privilegeSectionRef}
                className="rounded-lg border border-theme-border bg-theme-bg-card p-5"
            >
                <h4 className="text-sm font-medium text-theme-text mb-4 uppercase tracking-wider">{t('settings_view.local_terminal.shell')}</h4>
                <div className="space-y-5">
                    <div className="flex items-center justify-between">
                        <div>
                            <Label className="text-theme-text">{t('settings_view.local_terminal.default_shell')}</Label>
                            <p className="text-xs text-theme-text-muted mt-0.5">{t('settings_view.local_terminal.default_shell_hint')}</p>
                        </div>
                        <Select
                            value={defaultShellId || ''}
                            onValueChange={(value) => updateLocalTerminal('defaultShellId', value)}
                        >
                            <SelectTrigger className="w-[200px]">
                                <SelectValue placeholder={t('settings_view.local_terminal.select_shell')} />
                            </SelectTrigger>
                            <SelectContent>
                                {effectiveShells.map((shell) => (
                                    <SelectItem key={shell.id} value={shell.id}>
                                        {shell.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    {defaultShell && (
                        <div className="text-xs text-theme-text-muted bg-theme-bg-panel/30 p-3 rounded border border-theme-border/50">
                            <div className="flex items-center gap-2 mb-1">
                                <span className="text-theme-text-muted">{t('settings_view.local_terminal.path')}:</span>
                                <code className="text-theme-text">{defaultShell.path}</code>
                            </div>
                        </div>
                    )}

                    <Separator className="opacity-50" />

                    <div className="flex items-center justify-between">
                        <div>
                            <Label className="text-theme-text">{t('settings_view.local_terminal.git_bash_path')}</Label>
                            <p className="text-xs text-theme-text-muted mt-0.5">{t('settings_view.local_terminal.git_bash_path_hint')}</p>
                        </div>
                        <Input
                            value={localSettings?.gitBashPath || ''}
                            onChange={(event) => updateLocalTerminal('gitBashPath', event.target.value || null)}
                            placeholder={t('settings_view.local_terminal.git_bash_path_placeholder')}
                            className="w-[300px]"
                        />
                    </div>

                    <Separator className="opacity-50" />

                    <div className="flex items-center justify-between">
                        <div>
                            <Label className="text-theme-text">{t('settings_view.local_terminal.default_cwd')}</Label>
                            <p className="text-xs text-theme-text-muted mt-0.5">{t('settings_view.local_terminal.default_cwd_hint')}</p>
                        </div>
                        <Input
                            value={localSettings?.defaultCwd || ''}
                            onChange={(event) => updateLocalTerminal('defaultCwd', event.target.value)}
                            placeholder="~"
                            className="w-[200px]"
                        />
                    </div>
                </div>
            </div>

            <div className="rounded-lg border border-theme-border bg-theme-bg-card p-5">
                <h4 className="text-sm font-medium text-theme-text mb-4 uppercase tracking-wider">{t('settings_view.local_terminal.shell_profile')}</h4>
                <div className="space-y-5">
                    <div className="flex items-center justify-between">
                        <div>
                            <Label className="text-theme-text">{t('settings_view.local_terminal.load_shell_profile')}</Label>
                            <p className="text-xs text-theme-text-muted mt-0.5">{t('settings_view.local_terminal.load_shell_profile_hint')}</p>
                        </div>
                        <Checkbox
                            checked={localSettings?.loadShellProfile ?? true}
                            onCheckedChange={(checked) => updateLocalTerminal('loadShellProfile', checked === true)}
                        />
                    </div>
                </div>
            </div>

            <div className="rounded-lg border border-theme-border bg-theme-bg-card p-5">
                <div className="flex items-start justify-between gap-3 mb-4">
                    <div>
                        <h4 className="flex items-center gap-2 text-sm font-medium text-theme-text uppercase tracking-wider">
                            <KeyRound className="h-4 w-4 text-theme-text-muted" />
                            {t('settings_view.local_terminal.privilege_credentials')}
                        </h4>
                        <p className="mt-1 text-xs text-theme-text-muted">
                            {t('settings_view.local_terminal.privilege_credentials_hint')}
                        </p>
                    </div>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={resetPrivilegeDraft}
                        className="gap-1"
                    >
                        <Plus className="h-3.5 w-3.5" />
                        {t('sessionManager.privilege_credentials.new')}
                    </Button>
                </div>

                <div className="space-y-2">
                    {privilegeCredentials.length === 0 ? (
                        <p className="rounded-md border border-dashed border-theme-border/50 px-3 py-2 text-xs text-theme-text-muted">
                            {t('sessionManager.privilege_credentials.empty')}
                        </p>
                    ) : (
                        privilegeCredentials.map((credential) => (
                            <div key={credential.id} className="flex items-center gap-2 rounded-md border border-theme-border/50 bg-theme-bg-panel/30 px-2 py-1.5">
                                <KeyRound className="h-4 w-4 flex-shrink-0 text-amber-300" />
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm text-theme-text">{credential.label}</p>
                                    <p className="truncate text-xs text-theme-text-muted">
                                        {t(`sessionManager.privilege_credentials.kind.${credential.kind}`)}
                                    </p>
                                </div>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => startEditPrivilegeCredential(credential)}
                                >
                                    {t('sessionManager.privilege_credentials.edit')}
                                </Button>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    radius="sm"
                                    onClick={() => void handleDeletePrivilegeCredential(credential)}
                                    aria-label={t('sessionManager.privilege_credentials.delete')}
                                >
                                    <Trash2 className="h-4 w-4" />
                                </Button>
                            </div>
                        ))
                    )}
                </div>

                <div className="mt-3 grid gap-3 rounded-md border border-theme-border/50 bg-theme-bg/50 p-3">
                    <div className="grid gap-2">
                        <Label htmlFor="local-privilege-label">{t('sessionManager.privilege_credentials.label')}</Label>
                        <Input
                            id="local-privilege-label"
                            value={privilegeDraft.label}
                            onChange={(event) => setPrivilegeDraft((draft) => ({ ...draft, label: event.target.value }))}
                            placeholder={t('sessionManager.privilege_credentials.label_placeholder')}
                        />
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <div className="grid gap-2">
                            <Label>{t('sessionManager.privilege_credentials.kind_label')}</Label>
                            <Select
                                value={privilegeDraft.kind}
                                onValueChange={(value) => setPrivilegeDraft((draft) => ({
                                    ...draft,
                                    kind: value as PrivilegeCredentialKind,
                                }))}
                            >
                                <SelectTrigger>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="sudo_password">{t('sessionManager.privilege_credentials.kind.sudo_password')}</SelectItem>
                                    <SelectItem value="su_password">{t('sessionManager.privilege_credentials.kind.su_password')}</SelectItem>
                                    <SelectItem value="custom_prompt">{t('sessionManager.privilege_credentials.kind.custom_prompt')}</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor="local-privilege-username">{t('sessionManager.privilege_credentials.username_hint')}</Label>
                            <Input
                                id="local-privilege-username"
                                value={privilegeDraft.usernameHint}
                                onChange={(event) => setPrivilegeDraft((draft) => ({ ...draft, usernameHint: event.target.value }))}
                                placeholder={t('settings_view.local_terminal.privilege_username_placeholder')}
                            />
                        </div>
                    </div>

                    <div className="grid gap-2">
                        <Label htmlFor="local-privilege-secret">{t('sessionManager.privilege_credentials.secret')}</Label>
                        <Input
                            id="local-privilege-secret"
                            type="password"
                            value={privilegeDraft.secret}
                            onChange={(event) => setPrivilegeDraft((draft) => ({ ...draft, secret: event.target.value }))}
                            placeholder={privilegeDraft.credentialId
                                ? t('sessionManager.privilege_credentials.secret_keep_placeholder')
                                : t('sessionManager.privilege_credentials.secret_placeholder')}
                        />
                    </div>

                    <div className="grid gap-2">
                        <Label htmlFor="local-privilege-patterns">{t('sessionManager.privilege_credentials.prompt_patterns')}</Label>
                        <textarea
                            id="local-privilege-patterns"
                            value={privilegeDraft.promptPatterns}
                            onChange={(event) => setPrivilegeDraft((draft) => ({ ...draft, promptPatterns: event.target.value }))}
                            placeholder={t('sessionManager.privilege_credentials.prompt_patterns_placeholder')}
                            className="min-h-20 resize-y rounded-md border border-theme-border bg-theme-bg px-3 py-2 text-sm text-theme-text outline-none placeholder:text-theme-text-muted focus:border-theme-accent/60"
                        />
                        <p className="text-xs text-theme-text-muted">
                            {t('sessionManager.privilege_credentials.prompt_patterns_hint')}
                        </p>
                    </div>

                    <label className="flex items-center gap-2 text-sm text-theme-text">
                        <Checkbox
                            checked={privilegeDraft.enabled}
                            onCheckedChange={(checked) => setPrivilegeDraft((draft) => ({ ...draft, enabled: checked === true }))}
                        />
                        {t('sessionManager.privilege_credentials.enabled')}
                    </label>

                    {privilegeError && (
                        <p className="text-xs text-theme-error">{privilegeError}</p>
                    )}

                    <div className="flex justify-end gap-2">
                        {privilegeDraft.credentialId && (
                            <Button type="button" variant="ghost" size="sm" onClick={resetPrivilegeDraft}>
                                {t('sessionManager.privilege_credentials.cancel_edit')}
                            </Button>
                        )}
                        <Button
                            type="button"
                            size="sm"
                            onClick={() => void handleSavePrivilegeCredential()}
                            disabled={privilegeSaving || !privilegeDraft.label.trim()}
                            className="gap-1"
                        >
                            <SaveIcon className="h-3.5 w-3.5" />
                            {privilegeSaving
                                ? t('sessionManager.privilege_credentials.saving')
                                : t('sessionManager.privilege_credentials.save')}
                        </Button>
                    </div>
                </div>
            </div>

            <div className="rounded-lg border border-theme-border bg-theme-bg-card p-5">
                <h4 className="text-sm font-medium text-theme-text mb-4 uppercase tracking-wider">{t('settings_view.local_terminal.oh_my_posh')}</h4>
                <div className="space-y-5">
                    <div className="flex items-center justify-between">
                        <div>
                            <Label className="text-theme-text">{t('settings_view.local_terminal.oh_my_posh_enable')}</Label>
                            <p className="text-xs text-theme-text-muted mt-0.5">{t('settings_view.local_terminal.oh_my_posh_enable_hint')}</p>
                        </div>
                        <Checkbox
                            checked={localSettings?.ohMyPoshEnabled ?? false}
                            onCheckedChange={(checked) => updateLocalTerminal('ohMyPoshEnabled', checked === true)}
                        />
                    </div>

                    {localSettings?.ohMyPoshEnabled && (
                        <>
                            <div className="px-3 py-2 rounded bg-blue-500/10 border border-blue-500/20">
                                <p className="text-xs text-blue-400">
                                    💡 {t('settings_view.local_terminal.oh_my_posh_note')}
                                </p>
                            </div>
                            <Separator className="opacity-50" />
                            <div className="flex items-center justify-between">
                                <div>
                                    <Label className="text-theme-text">{t('settings_view.local_terminal.oh_my_posh_theme')}</Label>
                                    <p className="text-xs text-theme-text-muted mt-0.5">{t('settings_view.local_terminal.oh_my_posh_theme_hint')}</p>
                                </div>
                                <Input
                                    value={localSettings?.ohMyPoshTheme || ''}
                                    onChange={(event) => updateLocalTerminal('ohMyPoshTheme', event.target.value)}
                                    placeholder={t('settings_view.local_terminal.oh_my_posh_theme_placeholder')}
                                    className="w-[300px]"
                                />
                            </div>
                        </>
                    )}
                </div>
            </div>

            <div className="rounded-lg border border-theme-border bg-theme-bg-card p-5">
                <h4 className="text-sm font-medium text-theme-text mb-4 uppercase tracking-wider">{t('settings_view.local_terminal.shortcuts')}</h4>
                <div className="space-y-3 text-sm">
                    <div className="flex items-center justify-between py-2">
                        <span className="text-theme-text">{t('settings_view.local_terminal.new_default_shell')}</span>
                        <kbd className="px-2 py-1 bg-theme-bg-hover rounded text-xs text-theme-text-muted border border-theme-border">{platform.isMac ? '⌘T' : 'Ctrl+T'}</kbd>
                    </div>
                    <Separator className="opacity-30" />
                    <div className="flex items-center justify-between py-2">
                        <span className="text-theme-text">{t('settings_view.local_terminal.new_shell_launcher')}</span>
                        <kbd className="px-2 py-1 bg-theme-bg-hover rounded text-xs text-theme-text-muted border border-theme-border">{platform.isMac ? '⌘⇧T' : 'Ctrl+Shift+T'}</kbd>
                    </div>
                </div>
            </div>

            <div className="rounded-lg border border-theme-border bg-theme-bg-card p-5">
                <h4 className="text-sm font-medium text-theme-text mb-4 uppercase tracking-wider">{t('settings_view.local_terminal.available_shells')}</h4>
                <div className="space-y-2">
                    {effectiveShells.length === 0 ? (
                        <div className="text-center py-8 text-theme-text-muted">
                            {t('settings_view.local_terminal.loading_shells')}
                        </div>
                    ) : (
                        effectiveShells.map((shell) => (
                            <div
                                key={shell.id}
                                className="flex items-center justify-between p-3 rounded-md bg-theme-bg-panel/30 border border-theme-border/50"
                            >
                                <div className="flex items-center gap-3">
                                    <div>
                                        <div className="text-sm text-theme-text">{shell.label}</div>
                                        <div className="text-xs text-theme-text-muted">{shell.path}</div>
                                    </div>
                                </div>
                                {shell.id === defaultShellId && (
                                    <span className="text-xs text-yellow-500">{t('settings_view.local_terminal.default')}</span>
                                )}
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
};
