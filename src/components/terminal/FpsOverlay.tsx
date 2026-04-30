// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

/**
 * FpsOverlay — floating debug badge showing adaptive renderer stats.
 *
 * Displays in the top-left corner of the terminal pane when the user enables
 * "Show FPS Overlay" in Settings → Terminal.
 *
 * Metrics shown:
 *   • Tier badge  — [B] boost  [N] normal  [I] idle
 *   • FPS         — measured via its own RAF loop (display refresh rate when
 *                   boost/normal; actual flush rate when idle via WPS)
 *   • WPS         — terminal.write() calls per second (hook-measured)
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../../lib/utils';
import type { AdaptiveRendererHandle, RenderTier } from '../../hooks/useAdaptiveRenderer';
import { buildPerformanceSparklineBins, type PerformanceSparklineSample } from '../../lib/gpu';
import { useSettingsStore } from '../../store/settingsStore';
import { GpuChartCanvas } from '../gpu/GpuChartCanvas';

type Props = {
  getStats: AdaptiveRendererHandle['getStats'];
};

type Display = {
  tier: RenderTier;
  fps: number;
  wps: number;
};

const TIER_COLOR: Record<RenderTier, string> = {
  boost:  'text-green-400',
  normal: 'text-blue-400',
  idle:   'text-amber-400',
};

const TIER_LABEL: Record<RenderTier, string> = {
  boost:  'B',
  normal: 'N',
  idle:   'I',
};

const TIER_FULL: Record<RenderTier, string> = {
  boost:  'boost',
  normal: 'normal',
  idle:   'idle',
};

export function FpsOverlay({ getStats }: Props) {
  const [display, setDisplay] = useState<Display>({ tier: 'normal', fps: 0, wps: 0 });
  const [samples, setSamples] = useState<PerformanceSparklineSample[]>([]);
  const gpuCanvasEnabled = useSettingsStore((state) => state.settings.experimental?.gpuCanvas ?? false);
  const lanes = useMemo(() => buildPerformanceSparklineBins({ samples, binCount: 48 }), [samples]);

  // Track RAF frame count for FPS measurement
  const frameCountRef = useRef(0);
  const lastTimeRef = useRef(performance.now());

  useEffect(() => {
    let rafId: number;

    const tick = (now: number) => {
      frameCountRef.current++;
      const elapsed = now - lastTimeRef.current;

      // Update display every ~500ms
      if (elapsed >= 500) {
        const stats = getStats();
        const measuredFps = Math.round(frameCountRef.current / (elapsed / 1000));

        // In idle tier the RAF loop in xterm is paused, but our overlay's RAF
        // still runs at display rate. Use WPS as the effective "fps" instead.
        const displayFps = stats.tier === 'idle' ? stats.actualWps : measuredFps;

        const nextDisplay = { tier: stats.tier, fps: displayFps, wps: stats.actualWps };
        setDisplay(nextDisplay);
        setSamples((current) => [...current.slice(-47), nextDisplay]);
        frameCountRef.current = 0;
        lastTimeRef.current = now;
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [getStats]);

  return (
    <div
      className={cn(
        'absolute top-2 left-2 z-20',
        'flex items-center gap-1.5',
        'bg-theme-bg-sunken/85 border border-theme-border/50 rounded',
        'px-2 py-0.5',
        'pointer-events-none select-none',
        'font-mono text-[10px] leading-5',
      )}
      title={`Adaptive render tier: ${TIER_FULL[display.tier]}`}
    >
      {/* Tier badge */}
      <span className={cn('font-bold', TIER_COLOR[display.tier])}>
        {TIER_LABEL[display.tier]}
      </span>

      <span className="text-theme-text-muted">|</span>

      {/* FPS: display refresh rate (normal/boost) or flush rate (idle) */}
      <span className="text-theme-text">{display.fps}</span>
      <span className="text-theme-text-muted">fps</span>

      <span className="text-theme-text-muted">·</span>

      {/* WPS: writes per second */}
      <span className="text-theme-text-muted">{display.wps}</span>
      <span className="text-theme-text-muted">wps</span>

      <span className="text-theme-text-muted">·</span>
      <span className="h-5 w-20 overflow-hidden rounded-sm border border-theme-border/40 bg-theme-bg">
        <GpuChartCanvas
          kind="timeline"
          enabled={gpuCanvasEnabled}
          lanes={lanes}
          title="FPS/WPS trend"
        />
      </span>
    </div>
  );
}
