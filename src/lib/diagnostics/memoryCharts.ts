// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import {
  GPU_CHART_ACTIVE,
  GPU_CHART_BASE,
  GPU_CHART_ERROR,
  GPU_CHART_MATCH,
  GPU_CHART_VIEWPORT,
  GPU_CHART_WARNING,
  type GpuTimelineLanes,
} from '@/lib/gpu';
import type { MemoryDiagnosticsProviderSnapshot, MemoryDiagnosticsSnapshot } from './memoryDiagnosticsRegistry';

export function bytesFromMb(value: number): number {
  return Math.max(0, value) * 1024 * 1024;
}

function safeBinCount(count: number | undefined, fallback: number): number {
  return Math.max(1, Math.floor(count ?? fallback));
}

function riskFlag(provider: MemoryDiagnosticsProviderSnapshot): number {
  if (provider.risk === 'high') return GPU_CHART_ERROR;
  if (provider.risk === 'medium') return GPU_CHART_WARNING;
  return GPU_CHART_BASE;
}

function scaleToFlag(value: number, max: number): number {
  if (max <= 0 || value <= 0) return 0;
  const ratio = value / max;
  if (ratio > 0.80) return GPU_CHART_ERROR;
  if (ratio > 0.55) return GPU_CHART_WARNING;
  if (ratio > 0.25) return GPU_CHART_MATCH;
  return GPU_CHART_BASE;
}

export function estimateBackendScrollBytes(snapshot: MemoryDiagnosticsSnapshot): number {
  return snapshot.backend.scrollBuffers.reduce(
    (sum, buffer) => sum + bytesFromMb(buffer.memoryUsageMb),
    0,
  );
}

export function estimateFrontendBytes(snapshot: MemoryDiagnosticsSnapshot): number {
  const providerBytes = snapshot.frontend.providers.reduce(
    (sum, provider) => sum + (provider.estimatedBytes ?? 0),
    0,
  );
  return snapshot.frontend.webviewHeap.usedBytes ?? providerBytes;
}

export function buildMemoryTimelineBins(samples: MemoryDiagnosticsSnapshot[], binCount = 96): GpuTimelineLanes {
  const count = safeBinCount(binCount, 96);
  const lanes = [new Uint32Array(count), new Uint32Array(count), new Uint32Array(count)];
  if (samples.length === 0) return lanes;

  const visible = samples.slice(-count);
  const maxRss = Math.max(...visible.map((sample) => sample.backend.process.rssBytes ?? 0), 1);
  const maxFrontend = Math.max(...visible.map(estimateFrontendBytes), 1);
  const maxScroll = Math.max(...visible.map(estimateBackendScrollBytes), 1);

  visible.forEach((sample, index) => {
    const bin = Math.min(count - 1, Math.floor((index / Math.max(1, visible.length)) * count));
    lanes[0][bin] |= scaleToFlag(sample.backend.process.rssBytes ?? 0, maxRss);
    lanes[1][bin] |= scaleToFlag(estimateFrontendBytes(sample), maxFrontend);
    lanes[2][bin] |= scaleToFlag(estimateBackendScrollBytes(sample), maxScroll);
    if (index === visible.length - 1) {
      lanes[0][bin] |= GPU_CHART_ACTIVE;
      lanes[1][bin] |= GPU_CHART_ACTIVE;
      lanes[2][bin] |= GPU_CHART_ACTIVE;
    }
  });

  return lanes;
}

export function buildMemoryBreakdownBins(snapshot: MemoryDiagnosticsSnapshot | null, binCount = 64): Uint32Array {
  const count = safeBinCount(binCount, 64);
  const bins = new Uint32Array(count);
  if (!snapshot) return bins;

  const entries = [
    { bytes: snapshot.backend.process.rssBytes ?? 0, flag: GPU_CHART_ACTIVE },
    { bytes: estimateBackendScrollBytes(snapshot), flag: GPU_CHART_VIEWPORT },
    ...snapshot.frontend.providers.map((provider) => ({
      bytes: provider.estimatedBytes ?? 0,
      flag: riskFlag(provider),
    })),
  ].filter((entry) => entry.bytes > 0);

  const total = Math.max(1, entries.reduce((sum, entry) => sum + entry.bytes, 0));
  let cursor = 0;
  entries.forEach((entry) => {
    const width = Math.max(1, Math.round((entry.bytes / total) * count));
    for (let offset = 0; offset < width && cursor + offset < count; offset += 1) {
      bins[cursor + offset] |= entry.flag;
    }
    cursor += width;
  });

  return bins;
}

export function buildSessionMemoryHeatmap(snapshot: MemoryDiagnosticsSnapshot | null, binCount = 80): Uint32Array {
  const count = safeBinCount(binCount, 80);
  const bins = new Uint32Array(count);
  if (!snapshot || snapshot.backend.scrollBuffers.length === 0) return bins;

  const maxBytes = Math.max(
    ...snapshot.backend.scrollBuffers.map((buffer) => bytesFromMb(buffer.memoryUsageMb)),
    1,
  );

  snapshot.backend.scrollBuffers.slice(0, count).forEach((buffer, index) => {
    const bytes = bytesFromMb(buffer.memoryUsageMb);
    bins[index] |= scaleToFlag(bytes, maxBytes) || GPU_CHART_BASE;
    if (buffer.currentLines >= buffer.maxLines * 0.9) {
      bins[index] |= GPU_CHART_WARNING;
    }
  });

  return bins;
}
