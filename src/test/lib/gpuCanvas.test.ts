// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildEventTimelineBins,
  buildHistorySearchMapBins,
  buildPerformanceSparklineBins,
  buildScrollbackMinimapBins,
  GpuCanvasManager,
  GPU_CHART_ACTIVE,
  GPU_CHART_COLD,
  GPU_CHART_ERROR,
  GPU_CHART_MATCH,
  GPU_CHART_WARNING,
  SCROLLBACK_MINIMAP_ACTIVE_MATCH,
  SCROLLBACK_MINIMAP_MATCH,
  SCROLLBACK_MINIMAP_VIEWPORT,
} from '@/lib/gpu';

function setNavigatorGpu(value: unknown): void {
  Object.defineProperty(navigator, 'gpu', {
    configurable: true,
    value,
  });
}

describe('GpuCanvasManager', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as typeof globalThis & { GPUBufferUsage?: unknown }).GPUBufferUsage;
    delete (globalThis as typeof globalThis & { GPUShaderStage?: unknown }).GPUShaderStage;
    setNavigatorGpu(undefined);
  });

  it('reports unsupported when navigator.gpu is unavailable', async () => {
    setNavigatorGpu(undefined);
    const manager = new GpuCanvasManager();

    await expect(manager.detect()).resolves.toMatchObject({
      status: 'unsupported',
      backend: { kind: 'canvas2d' },
    });
  });

  it('shares one WebGPU device across multiple renderers and does not destroy it on renderer dispose', async () => {
    const destroyDevice = vi.fn();
    const requestDevice = vi.fn().mockResolvedValue({
      createShaderModule: vi.fn(() => ({})),
      createBindGroupLayout: vi.fn(() => ({})),
      createPipelineLayout: vi.fn(() => ({})),
      createRenderPipeline: vi.fn(() => ({})),
      createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
      createBindGroup: vi.fn(() => ({})),
      createCommandEncoder: vi.fn(),
      queue: { writeBuffer: vi.fn(), submit: vi.fn() },
      destroy: destroyDevice,
    });
    setNavigatorGpu({
      requestAdapter: vi.fn().mockResolvedValue({ requestDevice, info: { vendor: 'test' } }),
      getPreferredCanvasFormat: vi.fn(() => 'bgra8unorm'),
    });
    Object.defineProperty(globalThis, 'GPUBufferUsage', {
      configurable: true,
      value: { STORAGE: 1, COPY_DST: 2, UNIFORM: 4 },
    });
    Object.defineProperty(globalThis, 'GPUShaderStage', {
      configurable: true,
      value: { FRAGMENT: 1 },
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((contextId: string) => {
      if (contextId !== 'webgpu') return null;
      return {
        configure: vi.fn(),
        getCurrentTexture: vi.fn(() => ({ createView: vi.fn(() => ({})) })),
      } as unknown as RenderingContext;
    });

    const manager = new GpuCanvasManager();
    const first = await manager.createRenderer(document.createElement('canvas'));
    const second = await manager.createRenderer(document.createElement('canvas'));

    expect(first.backend.kind).toBe('webgpu');
    expect(second.backend.kind).toBe('webgpu');
    expect(requestDevice).toHaveBeenCalledTimes(1);

    manager.disposeRenderer(first.id);
    manager.disposeRenderer(second.id);

    expect(destroyDevice).not.toHaveBeenCalled();
    expect(manager.rendererCount()).toBe(0);
  });
});

describe('buildScrollbackMinimapBins', () => {
  it('maps live viewport and hot search matches into stable bins', () => {
    const bins = buildScrollbackMinimapBins({
      stats: {
        current_lines: 100,
        total_lines: 250,
        max_lines: 100,
        memory_usage_mb: 0.1,
      },
      visibleRange: { startIndex: 10, endIndex: 19 },
      searchMatches: [
        {
          source: 'hot',
          line_number: 155,
          column_start: 0,
          column_end: 2,
          matched_text: 'ls',
          line_content: 'ls',
        },
        {
          source: 'hot',
          line_number: 240,
          column_start: 0,
          column_end: 2,
          matched_text: 'ls',
          line_content: 'ls',
        },
        {
          source: 'cold',
          line_number: 20,
          column_start: 0,
          column_end: 2,
          matched_text: 'ls',
          line_content: 'ls',
          chunk_id: 'archive',
        },
      ],
      activeMatchIndex: 1,
      binCount: 10,
    });

    expect(bins[1] & SCROLLBACK_MINIMAP_VIEWPORT).toBeTruthy();
    expect(bins[0] & SCROLLBACK_MINIMAP_MATCH).toBeTruthy();
    expect(bins[9] & SCROLLBACK_MINIMAP_ACTIVE_MATCH).toBeTruthy();
    expect(Array.from(bins).filter((value) => (value & SCROLLBACK_MINIMAP_MATCH) !== 0)).toHaveLength(2);
  });
});

describe('GPU chart bin builders', () => {
  it('maps hot, archive, active, and truncated history search matches into bins', () => {
    const bins = buildHistorySearchMapBins({
      matches: [
        {
          source: 'hot',
          line_number: 100,
          column_start: 0,
          column_end: 2,
          matched_text: 'ls',
          line_content: 'ls',
        },
        {
          source: 'cold',
          line_number: 900,
          column_start: 0,
          column_end: 2,
          matched_text: 'ls',
          line_content: 'archived ls',
          chunk_id: 'chunk-1',
        },
      ],
      activeMatchIndex: 1,
      truncated: true,
      binCount: 10,
    });

    expect(bins[0] & GPU_CHART_MATCH).toBeTruthy();
    expect(bins[9] & GPU_CHART_COLD).toBeTruthy();
    expect(bins[9] & GPU_CHART_ACTIVE).toBeTruthy();
    expect(bins[9] & GPU_CHART_WARNING).toBeTruthy();
  });

  it('aggregates event timeline lanes by category with severity flags', () => {
    const lanes = buildEventTimelineBins({
      binCount: 6,
      entries: [
        { timestamp: 1000, category: 'connection', severity: 'info' },
        { timestamp: 2000, category: 'reconnect', severity: 'warn' },
        { timestamp: 3000, category: 'node', severity: 'error' },
      ],
    });

    expect(lanes).toHaveLength(3);
    expect(Array.from(lanes[0]).some(Boolean)).toBe(true);
    expect(Array.from(lanes[1]).some((value) => (value & GPU_CHART_WARNING) !== 0)).toBe(true);
    expect(Array.from(lanes[2]).some((value) => (value & GPU_CHART_ERROR) !== 0)).toBe(true);
  });

  it('builds bounded performance sparkline lanes for empty and populated samples', () => {
    expect(buildPerformanceSparklineBins({ samples: [], binCount: 4 }).map((lane) => lane.length)).toEqual([4, 4, 4]);

    const lanes = buildPerformanceSparklineBins({
      binCount: 4,
      samples: [
        { fps: 60, wps: 12, tier: 'boost' },
        { fps: 0, wps: 0, tier: 'idle' },
      ],
    });

    expect(lanes).toHaveLength(3);
    expect(Array.from(lanes[2]).some((value) => (value & GPU_CHART_ACTIVE) !== 0)).toBe(true);
    expect(Array.from(lanes[2]).some((value) => (value & GPU_CHART_WARNING) !== 0)).toBe(true);
  });
});
