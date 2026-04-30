// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import React, { useEffect, useRef, useState } from 'react';
import {
  drawHorizontalBinsCanvas2D,
  drawTimelineLanesCanvas2D,
  drawVerticalBinsCanvas2D,
  gpuCanvasManager,
  type GpuCanvasRenderer,
  type GpuCanvasStatus,
  type GpuTimelineLanes,
} from '../../lib/gpu';
import { cn } from '../../lib/utils';

type ChartKind = 'vertical' | 'horizontal' | 'timeline';

interface GpuChartCanvasProps {
  kind: ChartKind;
  enabled: boolean;
  bins?: Uint32Array;
  lanes?: GpuTimelineLanes;
  className?: string;
  title?: string;
  onClickBin?: (binIndex: number) => void;
}

function fallbackDraw(canvas: HTMLCanvasElement, kind: ChartKind, bins: Uint32Array | undefined, lanes: GpuTimelineLanes | undefined): void {
  if (kind === 'timeline') {
    drawTimelineLanesCanvas2D(canvas, lanes ?? []);
    return;
  }
  const safeBins = bins ?? new Uint32Array(1);
  if (kind === 'horizontal') {
    drawHorizontalBinsCanvas2D(canvas, safeBins);
    return;
  }
  drawVerticalBinsCanvas2D(canvas, safeBins);
}

function renderWithRenderer(renderer: GpuCanvasRenderer, kind: ChartKind, bins: Uint32Array | undefined, lanes: GpuTimelineLanes | undefined): void {
  if (kind === 'timeline') {
    renderer.renderTimelineLanes(lanes ?? []);
    return;
  }
  renderer.renderVerticalBins(bins ?? new Uint32Array(1));
}

export const GpuChartCanvas: React.FC<GpuChartCanvasProps> = ({
  kind,
  enabled,
  bins,
  lanes,
  className,
  title,
  onClickBin,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<GpuCanvasRenderer | null>(null);
  const [status, setStatus] = useState<GpuCanvasStatus>(enabled ? 'fallback' : 'disabled');
  const [sizeTick, setSizeTick] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => setSizeTick((tick) => tick + 1));
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!enabled || !canvas) {
      setStatus('disabled');
      return;
    }

    void gpuCanvasManager.createRenderer(canvas).then((renderer) => {
      if (cancelled) {
        gpuCanvasManager.disposeRenderer(renderer.id);
        return;
      }
      rendererRef.current = renderer;
      setStatus(renderer.status);
      renderWithRenderer(renderer, kind, bins, lanes);
    });

    return () => {
      cancelled = true;
      const renderer = rendererRef.current;
      if (renderer) {
        gpuCanvasManager.disposeRenderer(renderer.id);
        rendererRef.current = null;
      }
    };
  }, [enabled, kind]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = rendererRef.current;
    if (enabled && renderer) {
      renderWithRenderer(renderer, kind, bins, lanes);
    } else {
      fallbackDraw(canvas, kind, bins, lanes);
    }
  }, [bins, enabled, kind, lanes, sizeTick]);

  return (
    <canvas
      ref={canvasRef}
      className={cn('block h-full w-full', onClickBin && 'cursor-pointer', className)}
      title={title ? `${title} · ${status}` : status}
      onClick={(event) => {
        if (!onClickBin) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const length = kind === 'vertical' ? rect.height : rect.width;
        const offset = kind === 'vertical' ? event.clientY - rect.top : event.clientX - rect.left;
        const count = kind === 'timeline'
          ? Math.max(1, lanes?.[0]?.length ?? 1)
          : Math.max(1, bins?.length ?? 1);
        const ratio = length > 0 ? offset / length : 0;
        onClickBin(Math.min(count - 1, Math.max(0, Math.floor(ratio * count))));
      }}
    />
  );
};
