// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import type { RefObject } from 'react';

export type TerminalDimensions = { cols: number; rows: number };

type ResizeSchedulerOptions = {
  fitAddonRef: RefObject<FitAddon | null>;
  terminalRef: RefObject<Terminal | null>;
  isRenderable: () => boolean;
  getDimensions: () => TerminalDimensions | null;
  onResize: (dimensions: TerminalDimensions) => void;
  resizeDebounceMs?: number;
};

export type TerminalResizeScheduler = {
  scheduleFit: () => void;
  dispose: () => void;
};

export function createTerminalResizeScheduler(options: ResizeSchedulerOptions): TerminalResizeScheduler {
  let frame: number | null = null;
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  let lastResize: TerminalDimensions | null = null;
  const resizeDebounceMs = options.resizeDebounceMs ?? 100;

  const flushResize = () => {
    resizeTimer = null;
    const dimensions = options.getDimensions();
    if (!dimensions) return;
    if (lastResize && lastResize.cols === dimensions.cols && lastResize.rows === dimensions.rows) {
      return;
    }
    lastResize = dimensions;
    options.onResize(dimensions);
  };

  const scheduleResize = () => {
    if (resizeTimer) {
      clearTimeout(resizeTimer);
    }
    resizeTimer = setTimeout(flushResize, resizeDebounceMs);
  };

  const scheduleFit = () => {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      const fitAddon = options.fitAddonRef.current;
      if (!fitAddon || !options.terminalRef.current || !options.isRenderable()) return;
      // Command Bar can grow while typing. Batch terminal fit into RAF and
      // debounce PTY resize; otherwise every textarea line wrap triggers xterm
      // reflow plus backend resize.
      fitAddon.fit();
      scheduleResize();
    });
  };

  const dispose = () => {
    if (frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }
    if (resizeTimer) {
      clearTimeout(resizeTimer);
      resizeTimer = null;
    }
  };

  return { scheduleFit, dispose };
}
