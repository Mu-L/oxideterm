// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog';
import { Button } from '../ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Slider } from '../ui/slider';
import { useSettingsStore, type FontFamily, type Language } from '../../store/settingsStore';
import { api } from '../../lib/api';
import { useAppStore } from '../../store/appStore';
import { useLocalTerminalStore } from '../../store/localTerminalStore';
import { platform } from '../../lib/platform';
import { getTerminalTheme } from '../../lib/themes';
import {
  Download,
  Check,
  Terminal,
  Plus,
  Loader2,
  ArrowUpDown,
  Shield,
  RefreshCw,
  ArrowRight,
  ArrowLeft,
  Globe,
  Palette,
  Type,
  Command,
  Sparkles,
  SquareTerminal,
  Bot,
} from 'lucide-react';

// ============================================================================
// Onboarding Wizard — Multi-step welcome with settings configuration
// ============================================================================

/** Curated themes for the onboarding picker (dark + light variety) */
const ONBOARDING_THEMES = [
  'default', 'oxide', 'dracula', 'nord',
  'catppuccin-mocha', 'tokyo-night', 'paper-oxide', 'rose-pine',
] as const;

/** Language display labels */
const LANGUAGE_OPTIONS: { value: Language; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'fr-FR', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
  { value: 'es-ES', label: 'Español' },
  { value: 'it', label: 'Italiano' },
  { value: 'pt-BR', label: 'Português (BR)' },
  { value: 'vi', label: 'Tiếng Việt' },
];

/** Font display labels */
const FONT_OPTIONS: { value: FontFamily; label: string; bundled: boolean }[] = [
  { value: 'jetbrains', label: 'JetBrains Mono NF', bundled: true },
  { value: 'meslo', label: 'MesloLGM NF', bundled: true },
  { value: 'maple', label: 'Maple Mono NF CN', bundled: true },
  { value: 'cascadia', label: 'Cascadia Code', bundled: false },
  { value: 'consolas', label: 'Consolas', bundled: false },
  { value: 'menlo', label: 'Menlo', bundled: false },
];

const TOTAL_STEPS = 5; // 0..4

/** Mini terminal preview for theme cards */
const ThemeCard = ({
  themeId,
  selected,
  onClick,
}: {
  themeId: string;
  selected: boolean;
  onClick: () => void;
}) => {
  const theme = getTerminalTheme(themeId);
  const displayName = themeId.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

  return (
    <button
      onClick={onClick}
      className={`group rounded-md border-2 overflow-hidden transition-all ${
        selected
          ? 'border-[var(--theme-accent)] ring-1 ring-[var(--theme-accent)]/30'
          : 'border-theme-border hover:border-theme-border-strong'
      }`}
    >
      <div className="p-2.5" style={{ backgroundColor: theme.background }}>
        <div className="flex gap-1.5 mb-1.5">
          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: theme.red }} />
          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: theme.yellow }} />
          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: theme.green }} />
        </div>
        <div className="font-mono text-[10px] space-y-0.5 text-left" style={{ color: theme.foreground }}>
          <div>$ echo <span style={{ color: theme.green }}>"hi"</span></div>
          <div style={{ color: theme.blue }}>~</div>
        </div>
      </div>
      <div className="px-2.5 py-1.5 bg-theme-bg-panel border-t border-theme-border">
        <span className="text-[11px] font-medium text-theme-text">{displayName}</span>
      </div>
    </button>
  );
};

/** Font preview with configurable font family */
const FontPreviewBlock = ({ fontFamily, fontSize }: { fontFamily: string; fontSize: number }) => {
  const fontStack = useMemo(() => {
    const stacks: Record<string, string> = {
      jetbrains: '"JetBrainsMono Nerd Font", "JetBrains Mono NF (Subset)", "Maple Mono NF CN (Subset)", monospace',
      meslo: '"MesloLGM Nerd Font", "MesloLGM NF (Subset)", "Maple Mono NF CN (Subset)", monospace',
      maple: '"Maple Mono NF CN (Subset)", "Maple Mono NF", monospace',
      cascadia: '"Cascadia Code NF", "Cascadia Code", "Maple Mono NF CN (Subset)", monospace',
      consolas: 'Consolas, "Maple Mono NF CN (Subset)", monospace',
      menlo: 'Menlo, Monaco, "Maple Mono NF CN (Subset)", monospace',
    };
    return stacks[fontFamily] || stacks.jetbrains;
  }, [fontFamily]);

  return (
    <div
      className="rounded-md border border-theme-border bg-theme-bg-sunken p-4"
      style={{ fontFamily: fontStack, fontSize: `${fontSize}px` }}
    >
      <div className="text-theme-text leading-relaxed">
        <div>ABCDEFG abcdefg 0123456789</div>
        <div className="text-theme-text-muted">{'-> => == != <= >= {}'}</div>
        <div className="text-emerald-400">天地玄黄 The quick brown fox</div>
      </div>
    </div>
  );
};

export const OnboardingModal = () => {
  const { t } = useTranslation();
  const onboardingCompleted = useSettingsStore((s) => s.settings.onboardingCompleted);
  const completeOnboarding = useSettingsStore((s) => s.completeOnboarding);
  const language = useSettingsStore((s) => s.settings.general.language);
  const terminalTheme = useSettingsStore((s) => s.settings.terminal.theme);
  const fontFamily = useSettingsStore((s) => s.settings.terminal.fontFamily);
  const fontSize = useSettingsStore((s) => s.settings.terminal.fontSize);
  const setLanguage = useSettingsStore((s) => s.setLanguage);
  const updateTerminal = useSettingsStore((s) => s.updateTerminal);
  const { toggleModal } = useAppStore();
  const createLocalTerminal = useLocalTerminalStore((s) => s.createTerminal);
  const createTab = useAppStore((s) => s.createTab);

  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [hostCount, setHostCount] = useState<number | null>(null);
  const [importState, setImportState] = useState<'idle' | 'loading' | 'done'>('idle');
  const [importedCount, setImportedCount] = useState(0);

  useEffect(() => {
    if (!onboardingCompleted) {
      const timer = setTimeout(() => setOpen(true), 300);
      return () => clearTimeout(timer);
    }
  }, [onboardingCompleted]);

  // Scan SSH config hosts when reaching the quick-start step
  useEffect(() => {
    if (!open || step !== 3) return;
    api.listSshConfigHosts()
      .then((hosts) => setHostCount(hosts.filter((h) => h.alias !== '*').length))
      .catch(() => setHostCount(0));
  }, [open, step]);

  const handleClose = useCallback(() => {
    setOpen(false);
    completeOnboarding();
  }, [completeOnboarding]);

  const handleOpenTerminal = useCallback(async () => {
    handleClose();
    try {
      const info = await createLocalTerminal();
      createTab('local_terminal', info.id);
    } catch { /* ignore */ }
  }, [handleClose, createLocalTerminal, createTab]);

  const handleNewConnection = useCallback(() => {
    handleClose();
    toggleModal('newConnection', true);
  }, [handleClose, toggleModal]);

  const handleImportAll = useCallback(async () => {
    setImportState('loading');
    try {
      const hosts = await api.listSshConfigHosts();
      const filtered = hosts.filter((h) => h.alias !== '*');
      let count = 0;
      for (const host of filtered) {
        try {
          await api.importSshHost(host.alias);
          count++;
        } catch { /* skip */ }
      }
      setImportedCount(count);
    } catch { /* ignore */ }
    setImportState('done');
  }, []);

  if (onboardingCompleted) return null;

  const isMac = platform.isMac;

  const importLabel =
    importState === 'done'
      ? t('onboarding.import_ssh_done', { count: importedCount })
      : hostCount === null
        ? t('onboarding.importing')
        : hostCount > 0
          ? t('onboarding.import_ssh_desc', { count: hostCount })
          : t('onboarding.import_ssh_none');

  const canGoNext = step < TOTAL_STEPS - 1;
  const canGoBack = step > 0;

  // ── Step renderers ────────────────────────────────────────────────────────

  /** Step 0 — Welcome + Language */
  const renderWelcome = () => (
    <div className="px-6 pt-8 pb-6 space-y-6">
      <div className="text-center select-none">
        <div className="flex items-center justify-center gap-1">
          <h2 className="text-3xl font-bold tracking-tight text-theme-text empty-brand">
            {t('onboarding.welcome')}
          </h2>
          <span className="inline-block w-[3px] h-[0.7em] rounded-sm bg-theme-text opacity-40 translate-y-[1px]" />
        </div>
        <p className="text-sm text-theme-text-muted mt-2">{t('onboarding.subtitle')}</p>
      </div>

      <div className="rounded-md border border-theme-border bg-theme-bg-panel p-4 space-y-3">
        <p className="text-sm text-theme-text leading-relaxed">{t('onboarding.project_intro')}</p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-[var(--theme-accent)]" />
          <span className="text-sm font-medium text-theme-text">{t('onboarding.select_language')}</span>
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          {LANGUAGE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setLanguage(opt.value)}
              className={`px-3 py-2 rounded-sm text-xs font-medium transition-all ${
                language === opt.value
                  ? 'bg-[var(--theme-accent)] text-[var(--theme-accent-text)] shadow-sm'
                  : 'bg-theme-bg-panel border border-theme-border text-theme-text hover:border-theme-border-strong hover:bg-theme-bg-hover'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );

  /** Step 1 — Theme selection */
  const renderTheme = () => (
    <div className="px-6 pt-6 pb-6 space-y-4">
      <div className="flex items-center gap-2">
        <Palette className="h-5 w-5 text-[var(--theme-accent)]" />
        <div>
          <h3 className="text-lg font-semibold text-theme-text">{t('onboarding.select_theme')}</h3>
          <p className="text-xs text-theme-text-muted">{t('onboarding.theme_hint')}</p>
        </div>
      </div>
      <div className="grid grid-cols-4 gap-2">
        {ONBOARDING_THEMES.map((id) => (
          <ThemeCard
            key={id}
            themeId={id}
            selected={terminalTheme === id}
            onClick={() => updateTerminal('theme', id)}
          />
        ))}
      </div>
    </div>
  );

  /** Step 2 — Font + size */
  const renderFont = () => (
    <div className="px-6 pt-6 pb-6 space-y-4">
      <div className="flex items-center gap-2">
        <Type className="h-5 w-5 text-[var(--theme-accent)]" />
        <div>
          <h3 className="text-lg font-semibold text-theme-text">{t('onboarding.select_font')}</h3>
          <p className="text-xs text-theme-text-muted">{t('onboarding.font_hint')}</p>
        </div>
      </div>

      <Select value={fontFamily} onValueChange={(val) => updateTerminal('fontFamily', val as FontFamily)}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {FONT_OPTIONS.map((f) => (
            <SelectItem key={f.value} value={f.value}>
              {f.label}{f.bundled ? ' ✓' : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm text-theme-text">{t('onboarding.font_size')}</span>
          <span className="text-sm text-theme-text-muted font-mono">{fontSize}px</span>
        </div>
        <Slider
          min={8}
          max={32}
          step={1}
          value={fontSize}
          onChange={(v) => updateTerminal('fontSize', v)}
          className="w-full"
          aria-label={t('onboarding.font_size')}
        />
      </div>

      <FontPreviewBlock fontFamily={fontFamily} fontSize={fontSize} />
    </div>
  );

  /** Step 3 — Quick Start (SSH import + actions) */
  const renderQuickStart = () => (
    <div className="px-6 pt-6 pb-6 space-y-4">
      <div className="flex items-center gap-2">
        <Sparkles className="h-5 w-5 text-[var(--theme-accent)]" />
        <h3 className="text-lg font-semibold text-theme-text">{t('onboarding.quick_start')}</h3>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <button
          onClick={handleOpenTerminal}
          className="group flex flex-col items-center gap-2.5 px-3 py-4 rounded-sm border border-theme-border bg-theme-bg-panel hover:border-[var(--theme-accent)] hover:bg-theme-bg-hover transition-colors"
        >
          <Terminal className="h-5 w-5 text-theme-text-muted group-hover:text-[var(--theme-accent)] transition-colors" />
          <div className="text-center">
            <div className="text-xs font-medium text-theme-text">{t('onboarding.open_terminal')}</div>
            <div className="text-[11px] text-theme-text-muted mt-0.5 leading-relaxed">{t('onboarding.open_terminal_desc')}</div>
          </div>
        </button>

        <button
          onClick={handleNewConnection}
          className="group flex flex-col items-center gap-2.5 px-3 py-4 rounded-sm border border-theme-border bg-theme-bg-panel hover:border-[var(--theme-accent)] hover:bg-theme-bg-hover transition-colors"
        >
          <Plus className="h-5 w-5 text-theme-text-muted group-hover:text-[var(--theme-accent)] transition-colors" />
          <div className="text-center">
            <div className="text-xs font-medium text-theme-text">{t('onboarding.new_connection')}</div>
            <div className="text-[11px] text-theme-text-muted mt-0.5 leading-relaxed">{t('onboarding.new_connection_desc')}</div>
          </div>
        </button>

        <button
          onClick={importState === 'idle' && hostCount ? handleImportAll : undefined}
          disabled={importState !== 'idle' || !hostCount}
          className="group flex flex-col items-center gap-2.5 px-3 py-4 rounded-sm border border-theme-border bg-theme-bg-panel hover:border-[var(--theme-accent)] hover:bg-theme-bg-hover disabled:opacity-50 disabled:cursor-default disabled:hover:border-theme-border disabled:hover:bg-theme-bg-panel transition-colors"
        >
          {importState === 'loading' ? (
            <Loader2 className="h-5 w-5 text-theme-text-muted animate-spin" />
          ) : importState === 'done' ? (
            <Check className="h-5 w-5 text-green-500" />
          ) : (
            <Download className="h-5 w-5 text-theme-text-muted group-hover:text-[var(--theme-accent)] transition-colors" />
          )}
          <div className="text-center">
            <div className="text-xs font-medium text-theme-text">{t('onboarding.import_ssh')}</div>
            <div className="text-[11px] text-theme-text-muted mt-0.5 leading-relaxed">{importLabel}</div>
          </div>
        </button>
      </div>
    </div>
  );

  /** Step 4 — Features + Finish */
  const renderFeatures = () => (
    <div className="px-6 pt-6 pb-6 space-y-4">
      <h3 className="text-xs font-medium text-theme-text-muted uppercase tracking-wider">
        {t('onboarding.features')}
      </h3>
      <div className="grid grid-cols-2 gap-2">
        {([
          { icon: Command, key: 'cmd_palette', shortcut: isMac ? '⌘K' : 'Ctrl+K' },
          { icon: Bot, key: 'ai_chat', shortcut: null },
          { icon: RefreshCw, key: 'reconnect', shortcut: null },
          { icon: SquareTerminal, key: 'cli_companion', shortcut: null },
          { icon: ArrowUpDown, key: 'multiplexing', shortcut: null },
          { icon: Shield, key: 'security', shortcut: null },
        ] as const).map((item) => (
          <div key={item.key} className="flex gap-2.5 p-3 rounded-sm border border-theme-border bg-theme-bg-panel">
            <item.icon className="h-4 w-4 mt-0.5 shrink-0 text-[var(--theme-accent)]" />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium text-theme-text">{t(`onboarding.${item.key}`)}</span>
                {item.shortcut && (
                  <kbd className="px-1 py-0.5 rounded-sm bg-theme-bg border border-theme-border text-theme-text-muted font-mono text-[9px] leading-tight">
                    {item.shortcut}
                  </kbd>
                )}
              </div>
              <p className="text-[11px] text-theme-text-muted mt-0.5 leading-relaxed">{t(`onboarding.${item.key}_desc`)}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const STEP_ICONS = [Globe, Palette, Type, Sparkles, Shield];
  const stepRenderers = [renderWelcome, renderTheme, renderFont, renderQuickStart, renderFeatures];

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="sm:max-w-[600px] p-0 gap-0 overflow-hidden">
        <DialogTitle className="sr-only">{t('onboarding.welcome')}</DialogTitle>

        {/* ── Progress indicator ─────────────────────────────── */}
        <div className="flex items-center justify-center gap-1.5 pt-5 pb-1 select-none">
          {Array.from({ length: TOTAL_STEPS }, (_, i) => {
            const Icon = STEP_ICONS[i];
            return (
              <button
                key={i}
                onClick={() => setStep(i)}
                className={`flex items-center justify-center w-7 h-7 rounded-full transition-all focus-visible:ring-2 focus-visible:ring-[var(--theme-accent)] focus-visible:outline-none ${
                  i === step
                    ? 'bg-[var(--theme-accent)] text-[var(--theme-accent-text)] scale-110'
                    : i < step
                      ? 'bg-[var(--theme-accent)]/20 text-[var(--theme-accent)]'
                      : 'bg-theme-bg-panel text-theme-text-muted border border-theme-border'
                }`}
                aria-label={`Step ${i + 1}`}
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            );
          })}
        </div>

        {/* ── Step content ───────────────────────────────────── */}
        {stepRenderers[step]()}

        {/* ── Footer ─────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-theme-border bg-theme-bg-panel">
          <div className="flex items-center gap-2">
            {canGoBack && (
              <Button variant="ghost" size="sm" onClick={() => setStep(step - 1)} className="gap-1.5">
                <ArrowLeft className="h-3.5 w-3.5" />
                {t('onboarding.back')}
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {canGoNext && (
              <Button variant="ghost" size="sm" onClick={handleClose} className="text-theme-text-muted">
                {t('onboarding.skip')}
              </Button>
            )}
            {canGoNext ? (
              <Button size="sm" onClick={() => setStep(step + 1)} className="gap-1.5">
                {t('onboarding.next')}
                <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            ) : (
              <Button size="sm" onClick={handleClose} className="gap-1.5">
                {t('onboarding.start_exploring')}
                <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
