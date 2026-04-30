// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

export {
  gpuCanvasManager,
  GpuCanvasManager,
  type GpuCanvasBackend,
  type GpuCanvasDetection,
  type GpuCanvasRenderer,
  type GpuCanvasStatus,
} from './gpuCanvasManager';

export {
  buildScrollbackMinimapBins,
  drawScrollbackMinimapCanvas2D,
  SCROLLBACK_MINIMAP_ACTIVE_MATCH,
  SCROLLBACK_MINIMAP_HAS_LINE,
  SCROLLBACK_MINIMAP_MATCH,
  SCROLLBACK_MINIMAP_VIEWPORT,
  type ScrollbackMinimapInput,
  type ScrollbackMinimapVisibleRange,
} from './scrollbackMinimap';

export {
  buildEventTimelineBins,
  buildHistorySearchMapBins,
  buildPerformanceSparklineBins,
  drawHorizontalBinsCanvas2D,
  drawTimelineLanesCanvas2D,
  drawVerticalBinsCanvas2D,
  findEventTimelineEntryForBin,
  findHistorySearchMatchForBin,
  GPU_CHART_ACTIVE,
  GPU_CHART_BASE,
  GPU_CHART_COLD,
  GPU_CHART_ERROR,
  GPU_CHART_MATCH,
  GPU_CHART_TRUNCATED,
  GPU_CHART_VIEWPORT,
  GPU_CHART_WARNING,
  historySearchMatchToBin,
  type EventTimelineInput,
  type GpuTimelineLanes,
  type HistorySearchMapInput,
  type PerformanceSparklineInput,
  type PerformanceSparklineSample,
  type TimelineEventLike,
} from './chartData';
