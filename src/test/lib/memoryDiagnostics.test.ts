// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  buildMemoryBreakdownBins,
  buildMemoryTimelineBins,
  buildSessionMemoryHeatmap,
} from '@/lib/diagnostics/memoryCharts';
import type { MemoryDiagnosticsSnapshot } from '@/lib/diagnostics/memoryDiagnosticsRegistry';

function sample(overrides: Partial<MemoryDiagnosticsSnapshot> = {}): MemoryDiagnosticsSnapshot {
  return {
    capturedAt: 1,
    backend: {
      capturedAt: 1,
      process: { rssBytes: 1024 * 1024 * 512, virtualBytes: 1024 * 1024 * 900, threadCount: null, unavailableReason: null },
      remoteSessionCount: 1,
      localTerminalCount: 1,
      scrollBuffers: [{
        sessionId: 's1',
        terminalType: 'remote',
        currentLines: 7200,
        totalLines: 9000,
        maxLines: 8000,
        memoryUsageMb: 12,
      }],
    },
    frontend: {
      capturedAt: 1,
      webviewHeap: { usedBytes: null, totalBytes: null, limitBytes: null, unavailableReason: 'unavailable' },
      providers: [{
        id: 'terminal.registry',
        label: 'Terminal registry',
        category: 'terminal',
        objectCount: 2,
        estimatedBytes: 8192,
        risk: 'low',
      }],
    },
    ...overrides,
  };
}

describe('memory diagnostics chart builders', () => {
  it('builds stable timeline lanes for empty and populated samples', () => {
    expect(buildMemoryTimelineBins([])).toHaveLength(3);
    const lanes = buildMemoryTimelineBins([sample(), sample({ capturedAt: 2 })], 8);
    expect(lanes).toHaveLength(3);
    expect(lanes.every((lane) => lane.length === 8)).toBe(true);
  });

  it('builds a non-empty breakdown when diagnostics have data', () => {
    const bins = buildMemoryBreakdownBins(sample(), 16);
    expect(bins).toHaveLength(16);
    expect(Array.from(bins).some((flag) => flag !== 0)).toBe(true);
  });

  it('marks session heatmap bins and tolerates empty buffers', () => {
    expect(buildSessionMemoryHeatmap(sample({ backend: { ...sample().backend, scrollBuffers: [] } }), 4)).toEqual(new Uint32Array(4));
    const bins = buildSessionMemoryHeatmap(sample(), 4);
    expect(bins[0]).not.toBe(0);
  });
});
