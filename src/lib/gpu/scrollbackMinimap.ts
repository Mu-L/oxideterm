// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import type { BufferStats, HistorySearchMatch } from '@/types';
import {
  drawVerticalBinsCanvas2D,
  GPU_CHART_ACTIVE,
  GPU_CHART_BASE,
  GPU_CHART_MATCH,
  GPU_CHART_VIEWPORT,
} from './chartData';

export const SCROLLBACK_MINIMAP_HAS_LINE = GPU_CHART_BASE;
export const SCROLLBACK_MINIMAP_MATCH = GPU_CHART_MATCH;
export const SCROLLBACK_MINIMAP_ACTIVE_MATCH = GPU_CHART_ACTIVE;
export const SCROLLBACK_MINIMAP_VIEWPORT = GPU_CHART_VIEWPORT;

export interface ScrollbackMinimapVisibleRange {
  startIndex: number;
  endIndex: number;
}

export interface ScrollbackMinimapInput {
  stats: BufferStats | null;
  visibleRange: ScrollbackMinimapVisibleRange | null;
  searchMatches: HistorySearchMatch[];
  activeMatchIndex: number;
  binCount?: number;
}

function baseGlobalLine(stats: BufferStats): number {
  return Math.max(0, Number(stats.total_lines) - stats.current_lines);
}

function lineToBin(globalLine: number, base: number, currentLines: number, binCount: number): number {
  if (currentLines <= 0) return 0;
  const rowIndex = Math.min(Math.max(globalLine - base, 0), currentLines - 1);
  return Math.min(binCount - 1, Math.floor((rowIndex / currentLines) * binCount));
}

export function buildScrollbackMinimapBins(input: ScrollbackMinimapInput): Uint32Array {
  const binCount = Math.max(1, Math.floor(input.binCount ?? 96));
  const bins = new Uint32Array(binCount);
  const { stats } = input;
  if (!stats || stats.current_lines <= 0) return bins;

  const base = baseGlobalLine(stats);
  const end = base + stats.current_lines;

  for (let index = 0; index < binCount; index += 1) {
    bins[index] |= SCROLLBACK_MINIMAP_HAS_LINE;
  }

  if (input.visibleRange) {
    const visibleStart = base + Math.max(0, input.visibleRange.startIndex);
    const visibleEnd = base + Math.min(stats.current_lines - 1, input.visibleRange.endIndex);
    const startBin = lineToBin(visibleStart, base, stats.current_lines, binCount);
    const endBin = lineToBin(Math.max(visibleStart, visibleEnd), base, stats.current_lines, binCount);
    for (let index = startBin; index <= endBin; index += 1) {
      bins[index] |= SCROLLBACK_MINIMAP_VIEWPORT;
    }
  }

  input.searchMatches.forEach((match, matchIndex) => {
    if (match.source !== 'hot' || match.line_number < base || match.line_number >= end) return;
    const bin = lineToBin(match.line_number, base, stats.current_lines, binCount);
    bins[bin] |= SCROLLBACK_MINIMAP_MATCH;
    if (matchIndex === input.activeMatchIndex) {
      bins[bin] |= SCROLLBACK_MINIMAP_ACTIVE_MATCH;
    }
  });

  return bins;
}

export function drawScrollbackMinimapCanvas2D(canvas: HTMLCanvasElement, bins: Uint32Array): void {
  drawVerticalBinsCanvas2D(canvas, bins);
}
