// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import type { HistorySearchMatch } from '@/types';

export const GPU_CHART_BASE = 1 << 0;
export const GPU_CHART_MATCH = 1 << 1;
export const GPU_CHART_ACTIVE = 1 << 2;
export const GPU_CHART_VIEWPORT = 1 << 3;
export const GPU_CHART_COLD = 1 << 4;
export const GPU_CHART_WARNING = 1 << 5;
export const GPU_CHART_ERROR = 1 << 6;
export const GPU_CHART_TRUNCATED = 1 << 7;

export type GpuTimelineLanes = readonly Uint32Array[];

export interface HistorySearchMapInput {
  matches: HistorySearchMatch[];
  activeMatchIndex: number;
  binCount?: number;
  truncated?: boolean;
  partialFailure?: boolean;
}

export interface TimelineEventLike {
  timestamp: number;
  severity: 'info' | 'warn' | 'error';
  category: 'connection' | 'reconnect' | 'node';
}

export interface EventTimelineInput {
  entries: TimelineEventLike[];
  binCount?: number;
}

export interface PerformanceSparklineSample {
  fps: number;
  wps: number;
  tier: 'boost' | 'normal' | 'idle';
}

export interface PerformanceSparklineInput {
  samples: PerformanceSparklineSample[];
  binCount?: number;
}

function safeBinCount(count: number | undefined, fallback: number): number {
  return Math.max(1, Math.floor(count ?? fallback));
}

function lineDomain(matches: HistorySearchMatch[]): { min: number; max: number } {
  if (matches.length === 0) return { min: 0, max: 0 };
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  matches.forEach((match) => {
    min = Math.min(min, match.line_number);
    max = Math.max(max, match.line_number);
  });
  return { min: Number.isFinite(min) ? min : 0, max: Number.isFinite(max) ? max : 0 };
}

export function historySearchMatchToBin(match: HistorySearchMatch, matches: HistorySearchMatch[], binCount: number): number {
  const { min, max } = lineDomain(matches);
  if (max <= min) return 0;
  const ratio = (match.line_number - min) / (max - min + 1);
  return Math.min(binCount - 1, Math.max(0, Math.floor(ratio * binCount)));
}

export function findHistorySearchMatchForBin(
  matches: HistorySearchMatch[],
  binIndex: number,
  binCount: number,
): HistorySearchMatch | null {
  if (matches.length === 0) return null;
  const target = Math.min(binCount - 1, Math.max(0, binIndex));
  let best: HistorySearchMatch | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  matches.forEach((match) => {
    const distance = Math.abs(historySearchMatchToBin(match, matches, binCount) - target);
    if (distance < bestDistance) {
      best = match;
      bestDistance = distance;
    }
  });
  return best;
}

export function buildHistorySearchMapBins(input: HistorySearchMapInput): Uint32Array {
  const binCount = safeBinCount(input.binCount, 96);
  const bins = new Uint32Array(binCount);
  input.matches.forEach((match, index) => {
    const bin = historySearchMatchToBin(match, input.matches, binCount);
    bins[bin] |= GPU_CHART_MATCH;
    if (match.source === 'cold') bins[bin] |= GPU_CHART_COLD;
    if (index === input.activeMatchIndex) bins[bin] |= GPU_CHART_ACTIVE;
  });
  if (input.truncated || input.partialFailure) {
    bins[binCount - 1] |= GPU_CHART_TRUNCATED | GPU_CHART_WARNING;
  }
  return bins;
}

function timeDomain(entries: TimelineEventLike[]): { start: number; end: number } {
  if (entries.length === 0) return { start: 0, end: 0 };
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  entries.forEach((entry) => {
    start = Math.min(start, entry.timestamp);
    end = Math.max(end, entry.timestamp);
  });
  return { start: Number.isFinite(start) ? start : 0, end: Number.isFinite(end) ? end : 0 };
}

function timeToBin(timestamp: number, entries: TimelineEventLike[], binCount: number): number {
  const { start, end } = timeDomain(entries);
  if (end <= start) return 0;
  const ratio = (timestamp - start) / (end - start + 1);
  return Math.min(binCount - 1, Math.max(0, Math.floor(ratio * binCount)));
}

export function findEventTimelineEntryForBin<T extends TimelineEventLike>(
  entries: T[],
  binIndex: number,
  binCount: number,
): T | null {
  if (entries.length === 0) return null;
  const target = Math.min(binCount - 1, Math.max(0, binIndex));
  let best: T | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  entries.forEach((entry) => {
    const distance = Math.abs(timeToBin(entry.timestamp, entries, binCount) - target);
    if (distance < bestDistance) {
      best = entry;
      bestDistance = distance;
    }
  });
  return best;
}

export function buildEventTimelineBins(input: EventTimelineInput): Uint32Array[] {
  const binCount = safeBinCount(input.binCount, 120);
  const lanes = [new Uint32Array(binCount), new Uint32Array(binCount), new Uint32Array(binCount)];
  const laneByCategory: Record<TimelineEventLike['category'], number> = {
    connection: 0,
    reconnect: 1,
    node: 2,
  };

  input.entries.forEach((entry) => {
    const bin = timeToBin(entry.timestamp, input.entries, binCount);
    const lane = lanes[laneByCategory[entry.category]];
    lane[bin] |= GPU_CHART_BASE;
    if (entry.severity === 'warn') lane[bin] |= GPU_CHART_WARNING;
    if (entry.severity === 'error') lane[bin] |= GPU_CHART_ERROR;
  });

  return lanes;
}

export function buildPerformanceSparklineBins(input: PerformanceSparklineInput): Uint32Array[] {
  const binCount = safeBinCount(input.binCount, 48);
  const lanes = [new Uint32Array(binCount), new Uint32Array(binCount), new Uint32Array(binCount)];
  if (input.samples.length === 0) return lanes;

  input.samples.slice(-binCount).forEach((sample, sampleIndex, visibleSamples) => {
    const bin = Math.min(binCount - 1, Math.floor((sampleIndex / Math.max(1, visibleSamples.length)) * binCount));
    lanes[0][bin] |= sample.fps > 0 ? GPU_CHART_BASE : GPU_CHART_WARNING;
    lanes[1][bin] |= sample.wps > 0 ? GPU_CHART_MATCH : GPU_CHART_BASE;
    lanes[2][bin] |= sample.tier === 'boost'
      ? GPU_CHART_ACTIVE
      : sample.tier === 'idle'
        ? GPU_CHART_WARNING
        : GPU_CHART_BASE;
  });

  return lanes;
}

export function colorForChartFlags(flags: number): string {
  if ((flags & GPU_CHART_ACTIVE) !== 0) return 'rgba(234, 179, 8, 0.96)';
  if ((flags & GPU_CHART_ERROR) !== 0) return 'rgba(248, 113, 113, 0.90)';
  if ((flags & GPU_CHART_WARNING) !== 0) return 'rgba(251, 191, 36, 0.76)';
  if ((flags & GPU_CHART_COLD) !== 0) return 'rgba(168, 85, 247, 0.72)';
  if ((flags & GPU_CHART_MATCH) !== 0) return 'rgba(234, 179, 8, 0.62)';
  if ((flags & GPU_CHART_VIEWPORT) !== 0) return 'rgba(59, 130, 246, 0.66)';
  if ((flags & GPU_CHART_BASE) !== 0) return 'rgba(96, 165, 250, 0.30)';
  if ((flags & GPU_CHART_TRUNCATED) !== 0) return 'rgba(251, 191, 36, 0.40)';
  return 'rgba(30, 41, 59, 0.24)';
}

export function resizeCanvasToDisplaySize(canvas: HTMLCanvasElement): { width: number; height: number } {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.floor(rect.width * dpr));
  const height = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  return { width, height };
}

export function drawVerticalBinsCanvas2D(canvas: HTMLCanvasElement, bins: Uint32Array): void {
  const { width, height } = resizeCanvasToDisplaySize(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, width, height);

  const binHeight = height / Math.max(1, bins.length);
  for (let index = 0; index < bins.length; index += 1) {
    ctx.fillStyle = colorForChartFlags(bins[index]);
    ctx.fillRect(0, Math.floor(index * binHeight), width, Math.max(1, Math.ceil(binHeight)));
  }
}

export function drawHorizontalBinsCanvas2D(canvas: HTMLCanvasElement, bins: Uint32Array): void {
  const { width, height } = resizeCanvasToDisplaySize(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, width, height);

  const binWidth = width / Math.max(1, bins.length);
  for (let index = 0; index < bins.length; index += 1) {
    ctx.fillStyle = colorForChartFlags(bins[index]);
    ctx.fillRect(Math.floor(index * binWidth), 0, Math.max(1, Math.ceil(binWidth)), height);
  }
}

export function drawTimelineLanesCanvas2D(canvas: HTMLCanvasElement, lanes: GpuTimelineLanes): void {
  const { width, height } = resizeCanvasToDisplaySize(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, width, height);
  if (lanes.length === 0) return;

  const laneHeight = height / lanes.length;
  lanes.forEach((lane, laneIndex) => {
    const binWidth = width / Math.max(1, lane.length);
    for (let index = 0; index < lane.length; index += 1) {
      ctx.fillStyle = colorForChartFlags(lane[index]);
      ctx.fillRect(
        Math.floor(index * binWidth),
        Math.floor(laneIndex * laneHeight),
        Math.max(1, Math.ceil(binWidth)),
        Math.max(1, Math.ceil(laneHeight)),
      );
    }
  });
}
