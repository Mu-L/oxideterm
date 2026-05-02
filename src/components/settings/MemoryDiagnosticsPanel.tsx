// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, AlertTriangle, Download, Loader2, RefreshCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { GpuChartCanvas } from '@/components/gpu/GpuChartCanvas';
import { useMemoryDiagnosticsStore } from '@/store/memoryDiagnosticsStore';
import { useSettingsStore } from '@/store/settingsStore';
import { installBuiltinMemoryDiagnosticsProviders } from '@/lib/diagnostics/builtinMemoryProviders';
import {
  buildMemoryBreakdownBins,
  buildMemoryTimelineBins,
  buildSessionMemoryHeatmap,
  estimateBackendScrollBytes,
  estimateFrontendBytes,
} from '@/lib/diagnostics/memoryCharts';
import type { MemoryDiagnosticsProviderSnapshot, MemoryDiagnosticsSnapshot } from '@/lib/diagnostics/memoryDiagnosticsRegistry';

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function sumProviderBytes(providers: MemoryDiagnosticsProviderSnapshot[]): number {
  return providers.reduce((sum, provider) => sum + (provider.estimatedBytes ?? 0), 0);
}

function buildWarnings(snapshot: MemoryDiagnosticsSnapshot | null): string[] {
  if (!snapshot) return [];
  const warnings: string[] = [];
  const rss = snapshot.backend.process.rssBytes ?? 0;
  if (rss > 1024 * 1024 * 1024) warnings.push('rss_high');
  if (snapshot.backend.scrollBuffers.some((buffer) => buffer.currentLines >= buffer.maxLines * 0.9)) {
    warnings.push('scrollbuffer_near_cap');
  }
  if (snapshot.frontend.providers.some((provider) => provider.risk === 'high')) {
    warnings.push('frontend_high_risk');
  }
  if (snapshot.frontend.providers.some((provider) => provider.category === 'gpu' && provider.objectCount > 8)) {
    warnings.push('gpu_surfaces_many');
  }
  return warnings;
}

type MemoryDiagnosticsPanelProps = {
  onClose?: () => void;
};

export function MemoryDiagnosticsPanel({ onClose }: MemoryDiagnosticsPanelProps) {
  const { t } = useTranslation();
  const gpuCanvasEnabled = useSettingsStore((state) => Boolean(state.settings.experimental?.gpuCanvas));
  const {
    latest,
    samples,
    loading,
    error,
    recording,
    refresh,
    startRecording,
    stopRecording,
    clearSamples,
    exportReport,
  } = useMemoryDiagnosticsStore();

  useEffect(() => {
    installBuiltinMemoryDiagnosticsProviders();
    startRecording();
    return () => stopRecording();
  }, [startRecording, stopRecording]);

  const timeline = useMemo(() => buildMemoryTimelineBins(samples), [samples]);
  const breakdown = useMemo(() => buildMemoryBreakdownBins(latest), [latest]);
  const sessionHeatmap = useMemo(() => buildSessionMemoryHeatmap(latest), [latest]);
  const warnings = useMemo(() => buildWarnings(latest), [latest]);

  const exportDiagnostics = () => {
    const report = exportReport();
    if (!report) return;
    const blob = new Blob([report], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `oxideterm-memory-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const closeDiagnostics = () => {
    stopRecording();
    clearSamples();
    onClose?.();
  };

  const topCards = [
    {
      label: t('settings_view.help.memory_rss'),
      value: formatBytes(latest?.backend.process.rssBytes),
      hint: latest?.backend.process.unavailableReason ?? t('settings_view.help.memory_rss_hint'),
    },
    {
      label: t('settings_view.help.memory_webview_heap'),
      value: formatBytes(latest?.frontend.webviewHeap.usedBytes),
      hint: latest?.frontend.webviewHeap.unavailableReason ?? t('settings_view.help.memory_webview_heap_hint'),
    },
    {
      label: t('settings_view.help.memory_scrollback'),
      value: formatBytes(latest ? estimateBackendScrollBytes(latest) : null),
      hint: t('settings_view.help.memory_scrollback_hint', { count: latest?.backend.scrollBuffers.length ?? 0 }),
    },
    {
      label: t('settings_view.help.memory_frontend_estimate'),
      value: formatBytes(latest ? Math.max(sumProviderBytes(latest.frontend.providers), estimateFrontendBytes(latest)) : null),
      hint: t('settings_view.help.memory_frontend_estimate_hint'),
    },
  ];

  return (
    <div className="space-y-4 rounded-lg border border-theme-border/70 bg-theme-bg-elevated/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium text-theme-text">
            <Activity className="h-4 w-4 text-theme-accent" />
            {t('settings_view.help.memory_diagnostics_title')}
            {recording && <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-300">{t('settings_view.help.memory_recording')}</span>}
          </div>
          <p className="mt-1 text-xs leading-5 text-theme-text-muted">
            {t('settings_view.help.memory_diagnostics_hint')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" className="gap-2" onClick={() => void refresh()} disabled={loading}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {t('settings_view.help.memory_refresh')}
          </Button>
          <Button variant="outline" size="sm" className="gap-2" onClick={exportDiagnostics} disabled={!latest}>
            <Download className="h-3.5 w-3.5" />
            {t('settings_view.help.memory_export')}
          </Button>
          {onClose && (
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={closeDiagnostics} aria-label={t('settings_view.help.memory_close')}>
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-4">
        {topCards.map((card) => (
          <div key={card.label} className="rounded-md border border-theme-border/60 bg-theme-bg/60 p-3">
            <div className="text-xs text-theme-text-muted">{card.label}</div>
            <div className="mt-1 text-lg font-semibold tabular-nums text-theme-text">{card.value}</div>
            <div className="mt-1 line-clamp-2 text-xs text-theme-text-muted/80">{card.hint}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-3 lg:grid-cols-[1.3fr_1fr]">
        <div className="rounded-md border border-theme-border/60 bg-theme-bg/60 p-3">
          <div className="mb-2 flex items-center justify-between text-xs text-theme-text-muted">
            <span>{t('settings_view.help.memory_timeline')}</span>
            <span>{gpuCanvasEnabled ? t('settings_view.help.memory_gpu_enabled') : t('settings_view.help.memory_canvas2d')}</span>
          </div>
          <div className="h-24">
            <GpuChartCanvas kind="timeline" enabled={gpuCanvasEnabled} lanes={timeline} />
          </div>
        </div>
        <div className="rounded-md border border-theme-border/60 bg-theme-bg/60 p-3">
          <div className="mb-2 text-xs text-theme-text-muted">{t('settings_view.help.memory_breakdown')}</div>
          <div className="h-10">
            <GpuChartCanvas kind="horizontal" enabled={gpuCanvasEnabled} bins={breakdown} />
          </div>
          <div className="mt-3 h-10">
            <GpuChartCanvas kind="horizontal" enabled={gpuCanvasEnabled} bins={sessionHeatmap} />
          </div>
        </div>
      </div>

      {warnings.length > 0 && (
        <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
          {warnings.map((warning) => (
            <div key={warning} className="flex gap-2 text-sm text-amber-100">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{t(`settings_view.help.memory_warning_${warning}`)}</span>
            </div>
          ))}
        </div>
      )}

      <div className="overflow-hidden rounded-md border border-theme-border/60">
        <table className="w-full text-left text-sm">
          <thead className="bg-theme-bg/80 text-xs uppercase tracking-wide text-theme-text-muted">
            <tr>
              <th className="px-3 py-2">{t('settings_view.help.memory_source')}</th>
              <th className="px-3 py-2 text-right">{t('settings_view.help.memory_objects')}</th>
              <th className="px-3 py-2 text-right">{t('settings_view.help.memory_estimate')}</th>
              <th className="px-3 py-2">{t('settings_view.help.memory_risk')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-theme-border/50">
            {(latest?.frontend.providers ?? []).map((provider) => (
              <tr key={provider.id} className="text-theme-text">
                <td className="px-3 py-2">
                  <div>{provider.label}</div>
                  {provider.warning && <div className="text-xs text-amber-300">{provider.warning}</div>}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-theme-text-muted">{provider.objectCount}</td>
                <td className="px-3 py-2 text-right tabular-nums text-theme-text-muted">{formatBytes(provider.estimatedBytes)}</td>
                <td className="px-3 py-2 text-theme-text-muted">{t(`settings_view.help.memory_risk_${provider.risk ?? 'low'}`)}</td>
              </tr>
            ))}
            {(!latest || latest.frontend.providers.length === 0) && (
              <tr>
                <td colSpan={4} className="px-3 py-5 text-center text-theme-text-muted">
                  {t('settings_view.help.memory_no_providers')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs leading-5 text-theme-text-muted">
        {t('settings_view.help.memory_export_warning')}
      </p>
    </div>
  );
}
