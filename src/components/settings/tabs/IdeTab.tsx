// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import { useTranslation } from 'react-i18next';
import { Shield } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import type { IdeSettings, TerminalSettings } from '@/store/settingsStore';

type IdeTabProps = {
    ide?: IdeSettings;
    terminal: TerminalSettings;
    updateIde: <K extends keyof IdeSettings>(key: K, value: IdeSettings[K]) => void;
};

export const IdeTab = ({ ide, terminal, updateIde }: IdeTabProps) => {
    const { t } = useTranslation();

    return (
        <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div>
                <h3 className="text-2xl font-medium text-theme-text-heading mb-2">{t('settings_view.ide.title', 'IDE Mode (Mini)')}</h3>
                <p className="text-theme-text-muted">{t('settings_view.ide.description', 'Configure the built-in code editor behavior.')}</p>
            </div>
            <Separator />

            <div className="rounded-lg border border-theme-border bg-theme-bg-card p-5">
                <div className="flex items-center justify-between">
                    <div>
                        <Label className="text-theme-text">{t('settings_view.ide.auto_save', 'Auto Save')}</Label>
                        <p className="text-xs text-theme-text-muted mt-0.5">
                            {t('settings_view.ide.auto_save_hint', 'Automatically save files when switching tabs or losing focus.')}
                        </p>
                    </div>
                    <Checkbox
                        checked={ide?.autoSave ?? false}
                        onCheckedChange={(checked) => updateIde('autoSave', checked === true)}
                    />
                </div>
            </div>

            <div className="rounded-lg border border-theme-border bg-theme-bg-card p-5">
                <div className="flex items-center justify-between">
                    <div>
                        <Label className="text-theme-text">{t('settings_view.ide.word_wrap', 'Word Wrap')}</Label>
                        <p className="text-xs text-theme-text-muted mt-0.5">
                            {t('settings_view.ide.word_wrap_hint', 'Wrap long lines instead of horizontal scrolling.')}
                        </p>
                    </div>
                    <Checkbox
                        checked={ide?.wordWrap ?? false}
                        onCheckedChange={(checked) => updateIde('wordWrap', checked === true)}
                    />
                </div>
            </div>

            <div className="rounded-lg border border-theme-border bg-theme-bg-card p-5 space-y-4">
                <h4 className="text-sm font-medium text-theme-text uppercase tracking-wider">
                    {t('settings_view.ide.editor_typography', 'Editor Typography')}
                </h4>
                <p className="text-xs text-theme-text-muted">
                    {t('settings_view.ide.editor_typography_hint', 'Override terminal font size and line height for the code editor. Leave at "Follow Terminal" to use terminal settings.')}
                </p>

                <div className="flex items-center justify-between">
                    <div>
                        <Label className="text-theme-text">{t('settings_view.ide.font_size', 'Font Size')}</Label>
                        <p className="text-xs text-theme-text-muted mt-0.5">
                            {t('settings_view.ide.font_size_hint', 'Editor font size in pixels. Empty = follow terminal.')}
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        <Input
                            type="number"
                            min="8"
                            max="32"
                            step="1"
                            value={ide?.fontSize ?? ''}
                            placeholder={String(terminal.fontSize)}
                            onChange={(event) => {
                                const value = event.target.value;
                                updateIde('fontSize', value === '' ? null : Math.min(32, Math.max(8, parseInt(value, 10) || 14)));
                            }}
                            className="w-20"
                        />
                        <span className="text-xs text-theme-text-muted">px</span>
                    </div>
                </div>

                <Separator className="opacity-50" />

                <div className="flex items-center justify-between">
                    <div>
                        <Label className="text-theme-text">{t('settings_view.ide.line_height', 'Line Height')}</Label>
                        <p className="text-xs text-theme-text-muted mt-0.5">
                            {t('settings_view.ide.line_height_hint', 'Editor line spacing. Empty = follow terminal.')}
                        </p>
                    </div>
                    <Input
                        type="number"
                        step="0.1"
                        min="0.8"
                        max="3"
                        value={ide?.lineHeight ?? ''}
                        placeholder={String(terminal.lineHeight)}
                        onChange={(event) => {
                            const value = event.target.value;
                            updateIde('lineHeight', value === '' ? null : Math.min(3, Math.max(0.8, parseFloat(value) || 1.2)));
                        }}
                        className="w-20"
                    />
                </div>
            </div>

            <div className="rounded-lg border border-theme-border bg-theme-bg-card p-5 space-y-4">
                <h4 className="text-sm font-medium text-theme-text uppercase tracking-wider">
                    {t('settings_view.ide.agent_title', 'Remote Agent')}
                </h4>
                <p className="text-xs text-theme-text-muted">
                    {t('settings_view.ide.agent_description', 'OxideTerm can deploy a lightweight agent binary to remote hosts for enhanced IDE performance. The agent provides POSIX-native file operations, real-time file watching, and faster search — all running locally on the remote server.')}
                </p>
                <div className="space-y-3 text-xs">
                    <div className="flex items-start gap-2 text-theme-text-muted">
                        <div className="w-1 h-1 rounded-full bg-emerald-400 mt-1.5 shrink-0" />
                        <span>{t('settings_view.ide.agent_feature_atomic', 'Atomic file writes (no data loss on network disruption)')}</span>
                    </div>
                    <div className="flex items-start gap-2 text-theme-text-muted">
                        <div className="w-1 h-1 rounded-full bg-emerald-400 mt-1.5 shrink-0" />
                        <span>{t('settings_view.ide.agent_feature_watch', 'Real-time file watching via inotify (instant refresh)')}</span>
                    </div>
                    <div className="flex items-start gap-2 text-theme-text-muted">
                        <div className="w-1 h-1 rounded-full bg-emerald-400 mt-1.5 shrink-0" />
                        <span>{t('settings_view.ide.agent_feature_hash', 'Hash-based conflict detection (prevents overwriting external changes)')}</span>
                    </div>
                    <div className="flex items-start gap-2 text-theme-text-muted">
                        <div className="w-1 h-1 rounded-full bg-emerald-400 mt-1.5 shrink-0" />
                        <span>{t('settings_view.ide.agent_feature_search', 'Server-side grep and deep directory tree loading')}</span>
                    </div>
                </div>
                <div className="pt-2 border-t border-theme-border/50">
                    <div className="flex items-center justify-between">
                        <div>
                            <Label className="text-theme-text text-xs">{t('settings_view.ide.agent_supported', 'Supported Architectures')}</Label>
                            <p className="text-xs text-theme-text-muted mt-0.5">x86_64, aarch64 (Linux)</p>
                        </div>
                        <span className="text-xs text-theme-text-muted bg-theme-bg-panel px-2 py-1 rounded border border-theme-border/50">
                            ~1 MB
                        </span>
                    </div>
                </div>
                <p className="text-xs text-theme-text-muted italic">
                    {t('settings_view.ide.agent_auto_hint', 'The agent is deployed automatically when opening IDE mode on a supported Linux host. No manual configuration needed. Unsupported architectures fall back to SFTP seamlessly.')}
                </p>

                <Separator className="opacity-50" />

                <div className="flex items-center justify-between">
                    <div>
                        <Label className="text-theme-text">{t('settings_view.ide.agent_mode_label', 'Agent Deploy Policy')}</Label>
                        <p className="text-xs text-theme-text-muted mt-0.5">
                            {t('settings_view.ide.agent_mode_hint', 'Control whether the agent is deployed to remote hosts.')}
                        </p>
                    </div>
                    <Select
                        value={ide?.agentMode ?? 'ask'}
                        onValueChange={(value) => updateIde('agentMode', value as IdeSettings['agentMode'])}
                    >
                        <SelectTrigger className="w-40">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="ask">{t('settings_view.ide.agent_mode_ask', 'Ask Every Time')}</SelectItem>
                            <SelectItem value="enabled">{t('settings_view.ide.agent_mode_enabled', 'Always Enable')}</SelectItem>
                            <SelectItem value="disabled">{t('settings_view.ide.agent_mode_disabled', 'SFTP Only')}</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
            </div>

            <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-5 space-y-3">
                <h4 className="text-sm font-medium text-theme-text flex items-center gap-2">
                    <Shield className="h-4 w-4 text-blue-400" />
                    {t('settings_view.ide.agent_transparency_title', 'Transparency & Privacy')}
                </h4>
                <div className="space-y-2.5 text-xs text-theme-text-muted">
                    <div className="flex items-start gap-2">
                        <div className="w-1 h-1 rounded-full bg-blue-400 mt-1.5 shrink-0" />
                        <span>
                            <span className="text-theme-text font-medium">{t('settings_view.ide.agent_path_label', 'Deploy Path')}:</span>{' '}
                            {t('settings_view.ide.agent_path_detail', 'The agent binary is placed at ~/.oxideterm/oxideterm-agent in the remote user\'s home directory.')}
                        </span>
                    </div>
                    <div className="flex items-start gap-2">
                        <div className="w-1 h-1 rounded-full bg-blue-400 mt-1.5 shrink-0" />
                        <span>
                            <span className="text-theme-text font-medium">{t('settings_view.ide.agent_lifecycle_label', 'Lifecycle')}:</span>{' '}
                            {t('settings_view.ide.agent_lifecycle_detail', 'Deployed on first IDE mode open and persists between sessions. Automatically updated when a new version is available. Can be safely deleted at any time — it will be re-deployed when needed.')}
                        </span>
                    </div>
                    <div className="flex items-start gap-2">
                        <div className="w-1 h-1 rounded-full bg-blue-400 mt-1.5 shrink-0" />
                        <span>
                            <span className="text-theme-text font-medium">{t('settings_view.ide.agent_privacy_label', 'Privacy')}:</span>{' '}
                            {t('settings_view.ide.agent_privacy_detail', 'The agent is a standalone binary that communicates exclusively with OxideTerm over the existing SSH connection (stdio). It makes no third-party network connections, sends no telemetry, and collects no data.')}
                        </span>
                    </div>
                </div>
            </div>
        </div>
    );
};
