// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { Activity, ArrowLeftRight, Code2, Folder, FolderInput, ImageIcon, ListTree, Monitor, Network, Plus, Puzzle, Rocket, Settings, Terminal as TerminalIcon, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { platform } from '@/lib/platform';
import { cn } from '@/lib/utils';
import type { BackgroundFit, TerminalSettings } from '@/store/settingsStore';

type BackgroundImageSectionProps = {
    terminal: TerminalSettings;
    updateTerminal: <K extends keyof TerminalSettings>(key: K, value: TerminalSettings[K]) => void;
};

export const BackgroundImageSection = ({ terminal, updateTerminal }: BackgroundImageSectionProps) => {
    const { t } = useTranslation();
    const [processing, setProcessing] = useState(false);
    const [gallery, setGallery] = useState<string[]>([]);
    const galleryGenRef = useRef(0);
    const [localOpacity, setLocalOpacity] = useState(() => Math.round(terminal.backgroundOpacity * 100));
    const [localBlur, setLocalBlur] = useState(() => terminal.backgroundBlur);
    const opacityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        setLocalOpacity(Math.round(terminal.backgroundOpacity * 100));
    }, [terminal.backgroundOpacity]);
    useEffect(() => {
        setLocalBlur(terminal.backgroundBlur);
    }, [terminal.backgroundBlur]);

    const handleOpacityChange = useCallback((value: number) => {
        setLocalOpacity(value);
        if (opacityTimerRef.current) clearTimeout(opacityTimerRef.current);
        opacityTimerRef.current = setTimeout(() => updateTerminal('backgroundOpacity', value / 100), 150);
    }, [updateTerminal]);

    const handleBlurChange = useCallback((value: number) => {
        setLocalBlur(value);
        if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
        blurTimerRef.current = setTimeout(() => updateTerminal('backgroundBlur', value), 150);
    }, [updateTerminal]);

    const localOpacityRef = useRef(localOpacity);
    const localBlurRef = useRef(localBlur);
    localOpacityRef.current = localOpacity;
    localBlurRef.current = localBlur;

    useEffect(() => () => {
        if (opacityTimerRef.current) {
            clearTimeout(opacityTimerRef.current);
            updateTerminal('backgroundOpacity', localOpacityRef.current / 100);
        }
        if (blurTimerRef.current) {
            clearTimeout(blurTimerRef.current);
            updateTerminal('backgroundBlur', localBlurRef.current);
        }
    }, [updateTerminal]);

    const refreshGallery = useCallback(async () => {
        const generation = ++galleryGenRef.current;
        try {
            const paths = await invoke<string[]>('list_terminal_backgrounds');
            if (generation !== galleryGenRef.current) return;
            setGallery(paths);
        } catch (error) {
            console.error('[Background] Failed to list:', error);
        }
    }, []);

    useEffect(() => {
        refreshGallery();
    }, [refreshGallery]);

    const handleUploadImage = async () => {
        try {
            const selected = await openFileDialog({
                multiple: false,
                directory: false,
                title: t('settings_view.terminal.bg_select_title'),
                filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
            });
            if (!selected || typeof selected !== 'string') return;

            setProcessing(true);
            const result = await invoke<{ path: string }>('upload_terminal_background', { sourcePath: selected });
            updateTerminal('backgroundImage', result.path);
            await refreshGallery();
        } catch (error) {
            console.error('[Background] Failed to upload:', error);
        } finally {
            setProcessing(false);
        }
    };

    const handleActivate = (path: string) => {
        updateTerminal('backgroundImage', path);
    };

    const handleDeleteImage = async (path: string) => {
        try {
            await invoke('delete_terminal_background', { path });
            if (terminal.backgroundImage === path) {
                updateTerminal('backgroundImage', null);
            }
            await refreshGallery();
        } catch (error) {
            console.error('[Background] Failed to delete:', error);
        }
    };

    const handleClearAll = async () => {
        try {
            await invoke('clear_terminal_background');
            galleryGenRef.current++;
            updateTerminal('backgroundImage', null);
            setGallery([]);
        } catch {
            await refreshGallery();
        }
    };

    return (
        <div className="rounded-lg border border-theme-border bg-theme-bg-card p-5">
            <h4 className="text-sm font-medium text-theme-text mb-4 uppercase tracking-wider flex items-center gap-2">
                <ImageIcon className="h-4 w-4" />
                {t('settings_view.terminal.bg_title')}
            </h4>

            <div className="space-y-4">
                {terminal.backgroundImage && (
                    <div className="flex items-center justify-between">
                        <div>
                            <Label className="text-theme-text">{t('settings_view.terminal.bg_enabled')}</Label>
                            <p className="text-xs text-theme-text-muted mt-0.5">{t('settings_view.terminal.bg_enabled_hint')}</p>
                        </div>
                        <Checkbox
                            checked={terminal.backgroundEnabled !== false}
                            onCheckedChange={(value) => updateTerminal('backgroundEnabled', !!value)}
                        />
                    </div>
                )}

                <div>
                    <div className="flex items-center justify-between mb-2">
                        <Label className="text-theme-text">{t('settings_view.terminal.bg_gallery')}</Label>
                        <div className="flex items-center gap-2">
                            <Button variant="outline" size="sm" onClick={handleUploadImage} disabled={processing}>
                                <Plus className="h-3.5 w-3.5 mr-1" />
                                {processing ? '...' : t('settings_view.terminal.bg_add')}
                            </Button>
                            {gallery.length > 0 && (
                                <Button variant="ghost" size="sm" onClick={handleClearAll} className="text-red-400 hover:text-red-300">
                                    <Trash2 className="h-3.5 w-3.5 mr-1" />
                                    {t('settings_view.terminal.bg_clear_all')}
                                </Button>
                            )}
                        </div>
                    </div>
                    {gallery.length === 0 ? (
                        <p className="text-xs text-theme-text-muted">{t('settings_view.terminal.bg_hint')}</p>
                    ) : (
                        <div className="grid grid-cols-4 gap-2">
                            {gallery.map((path) => {
                                const isActive = terminal.backgroundImage === path;
                                const url = convertFileSrc(path);
                                return (
                                    <div
                                        key={path}
                                        className={cn(
                                            'relative group rounded-md overflow-hidden border-2 cursor-pointer transition-all aspect-video',
                                            isActive
                                                ? 'border-theme-accent ring-1 ring-theme-accent/50'
                                                : 'border-theme-border hover:border-theme-accent/50',
                                        )}
                                        onClick={() => handleActivate(path)}
                                    >
                                        <img
                                            src={url}
                                            alt=""
                                            className="w-full h-full object-cover"
                                            draggable={false}
                                        />
                                        {isActive && (
                                            <div className="absolute top-1 left-1 px-1.5 py-0.5 bg-theme-accent text-white text-[10px] rounded font-medium">
                                                {t('settings_view.terminal.bg_active')}
                                            </div>
                                        )}
                                        <button
                                            className="absolute top-1 right-1 p-0.5 rounded bg-black/60 text-white/80 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                handleDeleteImage(path);
                                            }}
                                        >
                                            <X className="h-3 w-3" />
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                {terminal.backgroundImage && (
                    <>
                        <div className="flex items-center justify-between">
                            <div>
                                <Label className="text-theme-text">{t('settings_view.terminal.bg_opacity')}</Label>
                                <p className="text-xs text-theme-text-muted mt-0.5">{t('settings_view.terminal.bg_opacity_hint')}</p>
                            </div>
                            <div className="flex items-center gap-2">
                                <Slider min={3} max={50} value={localOpacity} onChange={(value) => handleOpacityChange(value)} className="w-28" />
                                <span className="text-xs text-theme-text-muted w-10 text-right">{localOpacity}%</span>
                            </div>
                        </div>

                        <div className="flex items-center justify-between">
                            <div>
                                <Label className="text-theme-text">{t('settings_view.terminal.bg_blur')}</Label>
                                <p className="text-xs text-theme-text-muted mt-0.5">{t('settings_view.terminal.bg_blur_hint')}</p>
                            </div>
                            <div className="flex items-center gap-2">
                                <Slider min={0} max={20} value={localBlur} onChange={(value) => handleBlurChange(value)} className="w-28" />
                                <span className="text-xs text-theme-text-muted w-10 text-right">{localBlur}px</span>
                            </div>
                        </div>

                        <div className="flex items-center justify-between">
                            <div>
                                <Label className="text-theme-text">{t('settings_view.terminal.bg_fit')}</Label>
                                <p className="text-xs text-theme-text-muted mt-0.5">{t('settings_view.terminal.bg_fit_hint')}</p>
                            </div>
                            <Select
                                value={terminal.backgroundFit}
                                onValueChange={(value) => updateTerminal('backgroundFit', value as BackgroundFit)}
                            >
                                <SelectTrigger className="w-32">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="cover">{t('settings_view.terminal.bg_fit_cover')}</SelectItem>
                                    <SelectItem value="contain">{t('settings_view.terminal.bg_fit_contain')}</SelectItem>
                                    <SelectItem value="fill">{t('settings_view.terminal.bg_fit_fill')}</SelectItem>
                                    <SelectItem value="tile">{t('settings_view.terminal.bg_fit_tile')}</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>

                        <div>
                            <Label className="text-theme-text">{t('settings_view.terminal.bg_tabs')}</Label>
                            <p className="text-xs text-theme-text-muted mt-0.5 mb-3">{t('settings_view.terminal.bg_tabs_hint')}</p>
                            <div className="grid grid-cols-3 gap-2">
                                {([
                                    ['terminal', t('settings_view.terminal.bg_tab_terminal'), TerminalIcon],
                                    ['local_terminal', t('settings_view.terminal.bg_tab_local'), Monitor],
                                    ['sftp', t('settings_view.terminal.bg_tab_sftp'), FolderInput],
                                    ['forwards', t('settings_view.terminal.bg_tab_forwards'), ArrowLeftRight],
                                    ['settings', t('settings_view.terminal.bg_tab_settings'), Settings],
                                    ['ide', t('settings_view.terminal.bg_tab_ide'), Code2],
                                    ['connection_monitor', t('settings_view.terminal.bg_tab_monitor'), Activity],
                                    ['connection_pool', t('settings_view.terminal.bg_tab_connections'), Network],
                                    ['topology', t('settings_view.terminal.bg_tab_topology'), Network],
                                    ['file_manager', t('settings_view.terminal.bg_tab_files'), Folder],
                                    ['session_manager', t('settings_view.terminal.bg_tab_sessions'), ListTree],
                                    ...(platform.isMac ? [['launcher', t('settings_view.terminal.bg_tab_launcher'), Rocket] as const] : []),
                                    ['plugin_manager', t('settings_view.terminal.bg_tab_plugins'), Puzzle],
                                ] as const).map(([type, label, Icon]) => {
                                    const enabledTabs = terminal.backgroundEnabledTabs ?? ['terminal', 'local_terminal'];
                                    const checked = enabledTabs.includes(type);
                                    return (
                                        <button
                                            key={type}
                                            type="button"
                                            onClick={() => {
                                                const next = checked
                                                    ? enabledTabs.filter((tab) => tab !== type)
                                                    : [...enabledTabs, type];
                                                updateTerminal('backgroundEnabledTabs', next);
                                            }}
                                            className={cn(
                                                'flex items-center gap-2 rounded-md border px-3 py-2 text-xs transition-colors cursor-pointer select-none',
                                                checked
                                                    ? 'border-theme-accent/60 bg-theme-accent/10 text-theme-accent'
                                                    : 'border-theme-border bg-theme-bg-panel/30 text-theme-text-muted hover:border-theme-border hover:bg-theme-bg-hover/50',
                                            )}
                                        >
                                            <Icon className="size-3.5 shrink-0" />
                                            <span className="truncate">{label}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};
