// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { Download, Plus, Upload } from 'lucide-react';
import { BackgroundImageSection } from '@/components/settings/BackgroundImageSection';
import { ThemeEditorModal } from '@/components/settings/ThemeEditorModal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Slider } from '@/components/ui/slider';
import { useToast } from '@/hooks/useToast';
import { exportTheme, getCustomThemes, getTerminalTheme, importTheme, isCustomTheme, themes } from '@/lib/themes';
import type { AnimationSpeed, AppearanceSettings, FrostedGlassMode, TerminalSettings, UiDensity } from '@/store/settingsStore';

type AppearanceTabProps = {
    terminal: TerminalSettings;
    appearance: AppearanceSettings;
    updateTerminal: <K extends keyof TerminalSettings>(key: K, value: TerminalSettings[K]) => void;
    updateAppearance: <K extends keyof AppearanceSettings>(key: K, value: AppearanceSettings[K]) => void;
};

const formatThemeName = (key: string) => {
    if (isCustomTheme(key)) {
        const custom = getCustomThemes()[key];
        return custom ? custom.name : key.replace('custom:', '');
    }
    return key.split('-').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
};

const ThemePreview = ({ themeName }: { themeName: string }) => {
    const theme = getTerminalTheme(themeName);

    return (
        <div className="mt-2 p-3 rounded-md border border-theme-border" style={{ backgroundColor: theme.background }}>
            <div className="flex gap-2 mb-2">
                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: theme.red }}></div>
                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: theme.yellow }}></div>
                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: theme.green }}></div>
            </div>
            <div className="font-mono text-xs space-y-1" style={{ color: theme.foreground }}>
                <div>$ echo "Hello World"</div>
                <div style={{ color: theme.blue }}>~ <span style={{ color: theme.magenta }}>git</span> status</div>
                <div className="flex items-center">
                    <span>&gt; </span>
                    <span className="w-2 h-4 ml-1 animate-pulse" style={{ backgroundColor: theme.cursor }}></span>
                </div>
            </div>
        </div>
    );
};

export const AppearanceTab = ({ terminal, appearance, updateTerminal, updateAppearance }: AppearanceTabProps) => {
    const { t } = useTranslation();
    const { success: toastSuccess, error: toastError } = useToast();
    const [themeEditorOpen, setThemeEditorOpen] = useState(false);
    const [editingThemeId, setEditingThemeId] = useState<string | null>(null);
    const [localBorderRadius, setLocalBorderRadius] = useState(() => appearance.borderRadius);
    const [localUiFont, setLocalUiFont] = useState(() => appearance.uiFontFamily);
    const borderRadiusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const uiFontTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const localBorderRadiusRef = useRef(localBorderRadius);

    useEffect(() => {
        setLocalBorderRadius(appearance.borderRadius);
    }, [appearance.borderRadius]);

    useEffect(() => {
        setLocalUiFont(appearance.uiFontFamily);
    }, [appearance.uiFontFamily]);

    localBorderRadiusRef.current = localBorderRadius;

    const handleBorderRadiusChange = useCallback((value: number) => {
        setLocalBorderRadius(value);
        if (borderRadiusTimerRef.current) clearTimeout(borderRadiusTimerRef.current);
        borderRadiusTimerRef.current = setTimeout(() => updateAppearance('borderRadius', value), 150);
    }, [updateAppearance]);

    const handleUiFontChange = useCallback((value: string) => {
        setLocalUiFont(value);
        if (uiFontTimerRef.current) clearTimeout(uiFontTimerRef.current);
        uiFontTimerRef.current = setTimeout(() => updateAppearance('uiFontFamily', value), 300);
    }, [updateAppearance]);

    useEffect(() => () => {
        if (borderRadiusTimerRef.current) {
            clearTimeout(borderRadiusTimerRef.current);
            updateAppearance('borderRadius', localBorderRadiusRef.current);
        }
    }, [updateAppearance]);

    return (
        <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div>
                <h3 className="text-2xl font-medium text-theme-text-heading mb-2">{t('settings_view.appearance.title')}</h3>
                <p className="text-theme-text-muted">{t('settings_view.appearance.description')}</p>
            </div>
            <Separator />

            <div className="rounded-lg border border-theme-border bg-theme-bg-card p-5">
                <div className="flex items-center justify-between mb-4">
                    <h4 className="text-sm font-medium text-theme-text uppercase tracking-wider">{t('settings_view.appearance.theme')}</h4>
                    <div className="flex gap-2">
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs text-theme-text border-theme-border"
                            onClick={async () => {
                                try {
                                    const selected = await openFileDialog({
                                        multiple: false,
                                        filters: [{ name: 'JSON', extensions: ['json'] }],
                                    });
                                    if (!selected || typeof selected !== 'string') return;

                                    const { readTextFile } = await import('@tauri-apps/plugin-fs');
                                    const content = await readTextFile(selected);
                                    const { theme: imported } = importTheme(content);
                                    toastSuccess(t('settings_view.appearance.theme_import_success', { name: imported.name }));
                                } catch (error: unknown) {
                                    toastError(t('settings_view.appearance.theme_import_error', { error: error instanceof Error ? error.message : String(error) }));
                                }
                            }}
                        >
                            <Upload className="w-3 h-3 mr-1" />
                            {t('settings_view.appearance.theme_import')}
                        </Button>
                        {isCustomTheme(terminal.theme) && (
                            <Button
                                variant="outline"
                                size="sm"
                                className="h-7 text-xs text-theme-text border-theme-border"
                                onClick={() => {
                                    const json = exportTheme(terminal.theme);
                                    if (!json) return;
                                    const blob = new Blob([json], { type: 'application/json' });
                                    const url = URL.createObjectURL(blob);
                                    const anchor = document.createElement('a');
                                    anchor.href = url;
                                    anchor.download = `${formatThemeName(terminal.theme).replace(/\s+/g, '-').toLowerCase()}.oxtheme.json`;
                                    anchor.click();
                                    URL.revokeObjectURL(url);
                                    toastSuccess(t('settings_view.appearance.theme_export_success'));
                                }}
                            >
                                <Download className="w-3 h-3 mr-1" />
                                {t('settings_view.appearance.theme_export')}
                            </Button>
                        )}
                        {isCustomTheme(terminal.theme) && (
                            <Button
                                variant="outline"
                                size="sm"
                                className="h-7 text-xs text-theme-text border-theme-border"
                                onClick={() => {
                                    setEditingThemeId(terminal.theme);
                                    setThemeEditorOpen(true);
                                }}
                            >
                                {t('settings_view.custom_theme.edit')}
                            </Button>
                        )}
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs text-theme-text border-theme-border"
                            onClick={() => {
                                setEditingThemeId(null);
                                setThemeEditorOpen(true);
                            }}
                        >
                            <Plus className="w-3 h-3 mr-1" />
                            {t('settings_view.custom_theme.create')}
                        </Button>
                    </div>
                </div>
                <div className="space-y-4">
                    <div className="flex items-center justify-between">
                        <div>
                            <Label className="text-theme-text">{t('settings_view.appearance.color_theme')}</Label>
                            <p className="text-xs text-theme-text-muted mt-0.5">{t('settings_view.appearance.color_theme_hint')}</p>
                        </div>
                        <Select value={terminal.theme} onValueChange={(value) => updateTerminal('theme', value)}>
                            <SelectTrigger className="w-[200px] text-theme-text">
                                <SelectValue placeholder="Select theme">{formatThemeName(terminal.theme)}</SelectValue>
                            </SelectTrigger>
                            <SelectContent className="bg-theme-bg-panel border-theme-border max-h-[300px]">
                                {Object.keys(getCustomThemes()).length > 0 && (
                                    <>
                                        <SelectGroup>
                                            <SelectLabel className="text-theme-text-muted text-xs uppercase tracking-wider px-2 py-1.5 font-bold whitespace-normal break-words">{t('settings_view.appearance.theme_group_custom')}</SelectLabel>
                                            {Object.keys(getCustomThemes()).sort().map((key) => (
                                                <SelectItem key={key} value={key} className="text-theme-text focus:bg-theme-bg-hover focus:text-theme-text pl-4">
                                                    {formatThemeName(key)}
                                                </SelectItem>
                                            ))}
                                        </SelectGroup>
                                        <SelectSeparator className="bg-theme-bg-hover my-1" />
                                    </>
                                )}

                                <SelectGroup>
                                    <SelectLabel className="text-theme-text-muted text-xs uppercase tracking-wider px-2 py-1.5 font-bold whitespace-normal break-words">{t('settings_view.appearance.theme_group_oxide')}</SelectLabel>
                                    {['azurite', 'bismuth', 'chromium-oxide', 'cobalt', 'cuprite', 'hematite', 'malachite', 'magnetite', 'ochre', 'oxide', 'paper-oxide', 'silver-oxide', 'verdigris'].map((key) => (
                                        <SelectItem key={key} value={key} className="text-theme-text focus:bg-theme-bg-hover focus:text-theme-text pl-4">
                                            {formatThemeName(key)}
                                        </SelectItem>
                                    ))}
                                </SelectGroup>

                                <SelectSeparator className="bg-theme-bg-hover my-1" />

                                <SelectGroup>
                                    <SelectLabel className="text-theme-text-muted text-xs uppercase tracking-wider px-2 py-1.5 font-bold whitespace-normal break-words">{t('settings_view.appearance.theme_group_classic')}</SelectLabel>
                                    {Object.keys(themes)
                                        .filter((key) => !['azurite', 'bismuth', 'chromium-oxide', 'cobalt', 'cuprite', 'hematite', 'malachite', 'magnetite', 'ochre', 'oxide', 'paper-oxide', 'silver-oxide', 'verdigris'].includes(key))
                                        .sort()
                                        .map((key) => (
                                            <SelectItem key={key} value={key} className="text-theme-text focus:bg-theme-bg-hover focus:text-theme-text pl-4">
                                                {formatThemeName(key)}
                                            </SelectItem>
                                        ))}
                                </SelectGroup>
                            </SelectContent>
                        </Select>
                    </div>
                    <ThemePreview themeName={terminal.theme} />
                </div>
            </div>

            <div className="rounded-lg border border-theme-border bg-theme-bg-card p-5">
                <h4 className="text-sm font-medium text-theme-text mb-4 uppercase tracking-wider">{t('settings_view.appearance.layout')}</h4>
                <div className="space-y-5">
                    <div className="flex items-center justify-between">
                        <div>
                            <Label className="text-theme-text">{t('settings_view.appearance.density')}</Label>
                            <p className="text-xs text-theme-text-muted mt-0.5">{t('settings_view.appearance.density_hint')}</p>
                        </div>
                        <Select value={appearance.uiDensity} onValueChange={(value) => updateAppearance('uiDensity', value as UiDensity)}>
                            <SelectTrigger className="w-[180px] text-theme-text">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="bg-theme-bg-panel border-theme-border">
                                <SelectItem value="compact" className="text-theme-text focus:bg-theme-bg-hover focus:text-theme-text">{t('settings_view.appearance.density_compact')}</SelectItem>
                                <SelectItem value="comfortable" className="text-theme-text focus:bg-theme-bg-hover focus:text-theme-text">{t('settings_view.appearance.density_comfortable')}</SelectItem>
                                <SelectItem value="spacious" className="text-theme-text focus:bg-theme-bg-hover focus:text-theme-text">{t('settings_view.appearance.density_spacious')}</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="flex items-center justify-between">
                        <div>
                            <Label className="text-theme-text">{t('settings_view.appearance.border_radius')}</Label>
                            <p className="text-xs text-theme-text-muted mt-0.5">{t('settings_view.appearance.border_radius_hint')}</p>
                        </div>
                        <div className="flex items-center gap-2">
                            <svg width="24" height="24" viewBox="0 0 24 24" className="flex-shrink-0">
                                <path
                                    d={(() => {
                                        const size = 24;
                                        const radius = Math.min(localBorderRadius, size / 2);
                                        if (radius <= 0) return 'M0,0H24V24H0Z';
                                        const p = Math.min(radius * 1.28, size / 2);
                                        const controlPoint = p * 0.64;
                                        return [
                                            `M${p},0`,
                                            `L${size - p},0`,
                                            `C${size - p + controlPoint},0 ${size},${p - controlPoint} ${size},${p}`,
                                            `L${size},${size - p}`,
                                            `C${size},${size - p + controlPoint} ${size - p + controlPoint},${size} ${size - p},${size}`,
                                            `L${p},${size}`,
                                            `C${p - controlPoint},${size} 0,${size - p + controlPoint} 0,${size - p}`,
                                            `L0,${p}`,
                                            `C0,${p - controlPoint} ${p - controlPoint},0 ${p},0`,
                                            'Z',
                                        ].join(' ');
                                    })()}
                                    className="fill-theme-bg-hover stroke-theme-border"
                                    strokeWidth={1}
                                />
                            </svg>
                            <Slider min={0} max={16} value={localBorderRadius} onChange={(value) => handleBorderRadiusChange(value)} className="w-28" />
                            <span className="text-xs text-theme-text-muted w-12 text-right">{localBorderRadius}{t('settings_view.appearance.border_radius_unit')}</span>
                        </div>
                    </div>

                    <div className="flex items-center justify-between">
                        <div>
                            <Label className="text-theme-text">{t('settings_view.appearance.ui_font')}</Label>
                            <p className="text-xs text-theme-text-muted mt-0.5">{t('settings_view.appearance.ui_font_hint')}</p>
                        </div>
                        <Input value={localUiFont} onChange={(event) => handleUiFontChange(event.target.value)} placeholder={t('settings_view.appearance.ui_font_placeholder')} className="w-[180px]" />
                    </div>

                    <div className="flex items-center justify-between">
                        <div>
                            <Label className="text-theme-text">{t('settings_view.appearance.animation')}</Label>
                            <p className="text-xs text-theme-text-muted mt-0.5">{t('settings_view.appearance.animation_hint')}</p>
                        </div>
                        <Select value={appearance.animationSpeed} onValueChange={(value) => updateAppearance('animationSpeed', value as AnimationSpeed)}>
                            <SelectTrigger className="w-[180px] text-theme-text">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="bg-theme-bg-panel border-theme-border">
                                <SelectItem value="off" className="text-theme-text focus:bg-theme-bg-hover focus:text-theme-text">{t('settings_view.appearance.animation_off')}</SelectItem>
                                <SelectItem value="reduced" className="text-theme-text focus:bg-theme-bg-hover focus:text-theme-text">{t('settings_view.appearance.animation_reduced')}</SelectItem>
                                <SelectItem value="normal" className="text-theme-text focus:bg-theme-bg-hover focus:text-theme-text">{t('settings_view.appearance.animation_normal')}</SelectItem>
                                <SelectItem value="fast" className="text-theme-text focus:bg-theme-bg-hover focus:text-theme-text">{t('settings_view.appearance.animation_fast')}</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="flex items-center justify-between">
                        <div>
                            <Label className="text-theme-text">{t('settings_view.appearance.frosted_glass')}</Label>
                            <p className="text-xs text-theme-text-muted mt-0.5">{t('settings_view.appearance.frosted_glass_hint')}</p>
                        </div>
                        <Select value={appearance.frostedGlass} onValueChange={(value) => updateAppearance('frostedGlass', value as FrostedGlassMode)}>
                            <SelectTrigger className="w-[180px] text-theme-text">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="bg-theme-bg-panel border-theme-border">
                                <SelectItem value="off" className="text-theme-text focus:bg-theme-bg-hover focus:text-theme-text">{t('settings_view.appearance.frosted_glass_off')}</SelectItem>
                                <SelectItem value="css" className="text-theme-text focus:bg-theme-bg-hover focus:text-theme-text">{t('settings_view.appearance.frosted_glass_css')}</SelectItem>
                                <SelectItem value="native" className="text-theme-text focus:bg-theme-bg-hover focus:text-theme-text">{t('settings_view.appearance.frosted_glass_native')}</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                </div>
            </div>

            <BackgroundImageSection terminal={terminal} updateTerminal={updateTerminal} />

            <ThemeEditorModal
                open={themeEditorOpen}
                onOpenChange={setThemeEditorOpen}
                editThemeId={editingThemeId}
                baseThemeId={isCustomTheme(terminal.theme) ? undefined : terminal.theme}
            />
        </div>
    );
};