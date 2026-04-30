// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import {
  buildSelectionOverlayRects,
  getTerminalOverlayMetrics,
  prepareTerminalOverlayCanvas,
  terminalCellToOverlayPoint,
  terminalLineRangeToOverlayRange,
} from '@/lib/terminal/terminalOverlayCanvas';

function rect(width: number, height: number, left = 0, top = 0): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

function mockTerminal(): { term: Terminal; host: HTMLElement } {
  const element = document.createElement('div');
  const host = document.createElement('div');
  const rows = document.createElement('div');
  host.className = 'xterm-screen';
  rows.className = 'xterm-rows';
  host.getBoundingClientRect = vi.fn(() => rect(1000, 400, 0, 0));
  rows.getBoundingClientRect = vi.fn(() => rect(800, 360, 100, 20));
  Object.defineProperty(host, 'clientWidth', { value: 1000 });
  Object.defineProperty(host, 'clientHeight', { value: 400 });
  host.append(rows);
  element.append(host);

  return {
    host,
    term: {
      cols: 80,
      rows: 20,
      element,
      buffer: {
        active: {
          viewportY: 100,
        },
      },
    } as unknown as Terminal,
  };
}

describe('terminalOverlayCanvas', () => {
  it('uses viewport-relative line and cell coordinates for overlay points', () => {
    const { term, host } = mockTerminal();
    const metrics = getTerminalOverlayMetrics(term, host);

    expect(metrics).toMatchObject({
      rowTop: 20,
      rowLeft: 100,
      cellWidth: 10,
      cellHeight: 18,
      viewportY: 100,
    });
    expect(terminalCellToOverlayPoint(metrics!, 103, 4)).toEqual({
      visibleRow: 3,
      x: 140,
      y: 74,
    });
  });

  it('clips line ranges to the visible viewport before building rects', () => {
    const { term, host } = mockTerminal();
    const metrics = getTerminalOverlayMetrics(term, host)!;
    const range = terminalLineRangeToOverlayRange(metrics, 95, 103);

    expect(range).toMatchObject({
      visibleStartLine: 100,
      visibleEndLine: 103,
      hasTop: false,
      hasBottom: true,
      x: 100,
      y: 20,
      width: 800,
      height: 72,
    });
    expect(buildSelectionOverlayRects(range!)).toEqual([
      expect.objectContaining({ role: 'selection' }),
      expect.objectContaining({ role: 'selectionBottom' }),
    ]);
  });

  it('keeps the drawing canvas transparent to pointer events', () => {
    const { host } = mockTerminal();
    const canvas = document.createElement('canvas');

    prepareTerminalOverlayCanvas(canvas, host);

    expect(canvas.className).toBe('xterm-terminal-overlay-canvas');
    expect(canvas.style.pointerEvents).toBe('none');
    expect(canvas.style.inset).toBe('0px');
  });
});
