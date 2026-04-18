// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { ArrowDownToLine, Loader2, TerminalSquare, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { useConfirm } from '@/hooks/useConfirm';
import { useToast } from '@/hooks/useToast';
import { api } from '@/lib/api';
import type { DataDirInfo } from '@/types';
import type { GeneralSettings, Language } from '@/store/settingsStore';

type CliStatus = {
    bundled: boolean;
    installed: boolean;
    install_path: string | null;
    bundle_path: string | null;
    app_version: string;
    matches_bundled: boolean | null;
    needs_reinstall: boolean;
};

type GeneralTabProps = {
    general: GeneralSettings;
    setLanguage: (language: Language) => void;
};

export const GeneralTab = ({ general, setLanguage }: GeneralTabProps) => {
    const { t } = useTranslation();
    const { success: toastSuccess, error: toastError } = useToast();
    const { confirm, ConfirmDialog } = useConfirm();
    const [dataDirInfo, setDataDirInfo] = useState<DataDirInfo | null>(null);
    const [dataDirLoading, setDataDirLoading] = useState(false);
    const [cliStatus, setCliStatus] = useState<CliStatus | null>(null);
    const [cliLoading, setCliLoading] = useState(false);

    useEffect(() => {
        let cancelled = false;

        api.getDataDirectory()
            .then((info) => {
                if (!cancelled) setDataDirInfo(info);
            })
            .catch((error) => {
                console.error('Failed to load data directory info:', error);
            });

        api.cliGetStatus()
            .then((status) => {
                if (!cancelled) setCliStatus(status);
            })
            .catch((error) => {
                console.error('Failed to load CLI status:', error);
            });

        return () => {
            cancelled = true;
        };
    }, []);

    return (
        <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div>
                <h3 className="text-2xl font-medium text-theme-text-heading mb-2">{t('settings_view.general.title')}</h3>
                <p className="text-theme-text-muted">{t('settings_view.general.description')}</p>
            </div>
            <Separator />

            <div className="rounded-lg border border-theme-border bg-theme-bg-card p-5">
                <h4 className="text-sm font-medium text-theme-text mb-4 uppercase tracking-wider">
                    {t('settings_view.general.language')}
                </h4>
                <div className="space-y-5">
                    <div className="flex items-center justify-between">
                        <div>
                            <Label className="text-theme-text">{t('settings_view.general.language')}</Label>
                            <p className="text-xs text-theme-text-muted mt-0.5">{t('settings_view.general.language_hint')}</p>
                        </div>
                        <Select value={general.language} onValueChange={(value) => setLanguage(value as Language)}>
                            <SelectTrigger className="w-[200px]">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="de">Deutsch</SelectItem>
                                <SelectItem value="en">English</SelectItem>
                                <SelectItem value="es-ES">Español (España)</SelectItem>
                                <SelectItem value="fr-FR">Français (France)</SelectItem>
                                <SelectItem value="it">Italiano</SelectItem>
                                <SelectItem value="ko">한국어</SelectItem>
                                <SelectItem value="pt-BR">Português (Brasil)</SelectItem>
                                <SelectItem value="vi">Tiếng Việt</SelectItem>
                                <SelectItem value="ja">日本語</SelectItem>
                                <SelectItem value="zh-CN">简体中文</SelectItem>
                                <SelectItem value="zh-TW">繁體中文</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                </div>
            </div>

            <div className="rounded-lg border border-theme-border bg-theme-bg-card p-5">
                <h4 className="text-sm font-medium text-theme-text mb-4 uppercase tracking-wider">
                    {t('settings_view.general.data_directory')}
                </h4>
                <div className="space-y-4">
                    <div>
                        <Label className="text-theme-text">{t('settings_view.general.data_directory')}</Label>
                        <p className="text-xs text-theme-text-muted mt-0.5">{t('settings_view.general.data_directory_hint')}</p>
                    </div>
                    {dataDirInfo && (
                        <div className="flex items-center gap-3">
                            <code className="flex-1 px-3 py-2 bg-theme-bg-subtle rounded text-sm text-theme-text font-mono truncate">
                                {dataDirInfo.path}
                            </code>
                            {dataDirInfo.can_change && (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={dataDirLoading}
                                    onClick={async () => {
                                        const selected = await openFileDialog({
                                            directory: true,
                                            title: t('settings_view.general.select_data_directory'),
                                        });
                                        if (!selected || typeof selected !== 'string') return;

                                        setDataDirLoading(true);
                                        try {
                                            const check = await api.checkDataDirectory(selected);
                                            if (check.has_existing_data) {
                                                const proceed = await confirm({
                                                    title: t('settings_view.general.data_directory_conflict'),
                                                    description: t('settings_view.general.data_directory_conflict_detail', {
                                                        files: check.files_found.join(', '),
                                                    }),
                                                });
                                                if (!proceed) return;
                                            }
                                            await api.setDataDirectory(selected);
                                            toastSuccess(t('settings_view.general.data_directory_changed'));
                                            setDataDirInfo((current) => current
                                                ? {
                                                    ...current,
                                                    path: selected,
                                                    is_custom: true,
                                                    is_portable: false,
                                                    can_change: true,
                                                }
                                                : current);
                                        } catch (error) {
                                            toastError(String(error));
                                        } finally {
                                            setDataDirLoading(false);
                                        }
                                    }}
                                >
                                    {t('settings_view.general.change')}
                                </Button>
                            )}
                            {dataDirInfo.can_change && dataDirInfo.is_custom && (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={dataDirLoading}
                                    onClick={async () => {
                                        const confirmed = await confirm({
                                            title: t('settings_view.general.reset_data_directory'),
                                            description: t('settings_view.general.reset_data_directory_confirm'),
                                        });
                                        if (!confirmed) return;

                                        setDataDirLoading(true);
                                        try {
                                            await api.resetDataDirectory();
                                            toastSuccess(t('settings_view.general.data_directory_reset'));
                                            setDataDirInfo((current) => current
                                                ? {
                                                    ...current,
                                                    path: current.default_path,
                                                    is_custom: false,
                                                    is_portable: false,
                                                    can_change: true,
                                                }
                                                : current);
                                        } catch (error) {
                                            toastError(String(error));
                                        } finally {
                                            setDataDirLoading(false);
                                        }
                                    }}
                                >
                                    {t('settings_view.general.reset_to_default')}
                                </Button>
                            )}
                        </div>
                    )}
                    <p className="text-xs text-yellow-500">
                        {t('settings_view.general.data_directory_restart_notice')}
                    </p>
                </div>
            </div>

            <div className="rounded-lg border border-theme-border bg-theme-bg-card p-5">
                <h4 className="text-sm font-medium text-theme-text mb-4 uppercase tracking-wider">
                    {t('settings_view.general.cli_companion')}
                </h4>
                <div className="space-y-4">
                    <div>
                        <Label className="text-theme-text">{t('settings_view.general.cli_tool')}</Label>
                        <p className="text-xs text-theme-text-muted mt-0.5">{t('settings_view.general.cli_tool_hint')}</p>
                    </div>

                    {cliStatus && (
                        <div className="space-y-3">
                            <div className="flex items-center gap-3">
                                <div className="flex-1">
                                    <div className="flex items-center gap-2 mb-1">
                                        <TerminalSquare className="h-4 w-4 text-theme-text-muted" />
                                        <span className="text-sm text-theme-text font-mono">oxide</span>
                                        {cliStatus.installed && cliStatus.needs_reinstall ? (
                                            <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-500">{t('settings_view.general.cli_reinstall_required')}</span>
                                        ) : cliStatus.installed ? (
                                            <span className="text-xs px-1.5 py-0.5 rounded bg-green-500/10 text-green-500">{t('settings_view.general.cli_installed')}</span>
                                        ) : (
                                            <span className="text-xs px-1.5 py-0.5 rounded bg-theme-bg-subtle text-theme-text-muted">{t('settings_view.general.cli_not_installed')}</span>
                                        )}
                                    </div>
                                    {cliStatus.install_path && (
                                        <code className="text-xs text-theme-text-muted font-mono">{cliStatus.install_path}</code>
                                    )}
                                    {cliStatus.installed && cliStatus.needs_reinstall && (
                                        <p className="text-xs text-amber-500 mt-1">{t('settings_view.general.cli_reinstall_hint', { version: cliStatus.app_version })}</p>
                                    )}
                                </div>
                                {cliStatus.bundled && (!cliStatus.installed || cliStatus.needs_reinstall) && (
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={cliLoading}
                                        onClick={async () => {
                                            setCliLoading(true);
                                            try {
                                                const message = await api.cliInstall();
                                                toastSuccess(message);
                                                setCliStatus(await api.cliGetStatus());
                                            } catch (error) {
                                                toastError(String(error));
                                            } finally {
                                                setCliLoading(false);
                                            }
                                        }}
                                    >
                                        {cliLoading ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <ArrowDownToLine className="h-3 w-3 mr-1" />}
                                        {cliStatus.needs_reinstall ? t('settings_view.general.cli_reinstall') : t('settings_view.general.cli_install')}
                                    </Button>
                                )}
                                {cliStatus.installed && (
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        disabled={cliLoading}
                                        onClick={async () => {
                                            setCliLoading(true);
                                            try {
                                                const message = await api.cliUninstall();
                                                toastSuccess(message);
                                                setCliStatus(await api.cliGetStatus());
                                            } catch (error) {
                                                toastError(String(error));
                                            } finally {
                                                setCliLoading(false);
                                            }
                                        }}
                                    >
                                        <Trash2 className="h-3 w-3 mr-1" />
                                        {t('settings_view.general.cli_uninstall')}
                                    </Button>
                                )}
                            </div>
                            {!cliStatus.bundled && (
                                <p className="text-xs text-theme-text-muted">
                                    {t('settings_view.general.cli_not_bundled')}
                                </p>
                            )}
                        </div>
                    )}
                </div>
            </div>
            {ConfirmDialog}
        </div>
    );
};