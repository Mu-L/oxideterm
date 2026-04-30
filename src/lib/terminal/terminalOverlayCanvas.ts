// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import type { Terminal } from '@xterm/xterm';

export type TerminalOverlayRectRole =
  | 'selection'
  | 'selectionTop'
  | 'selectionBottom'
  | 'mark'
  | 'search'
  | 'activeSearch';

export type TerminalOverlayRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  role: TerminalOverlayRectRole;
  stale?: boolean;
};

export type TerminalOverlayMetrics = {
  rowTop: number;
  rowLeft: number;
  cellWidth: number;
  cellHeight: number;
  viewportY: number;
  rows: number;
  cols: number;
  width: number;
  height: number;
};

export type TerminalOverlayLineRange = {
  x: number;
  y: number;
  width: number;
  height: number;
  hasTop: boolean;
  hasBottom: boolean;
  visibleStartLine: number;
  visibleEndLine: number;
};

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function getTerminalOverlayHost(term: Terminal): HTMLElement | null {
  return term.element?.querySelector<HTMLElement>('.xterm-screen') ?? null;
}

export function getTerminalOverlayMetrics(term: Terminal, host: HTMLElement): TerminalOverlayMetrics | null {
  const rowsElement = term.element?.querySelector<HTMLElement>('.xterm-rows') ?? null;
  const hostRect = host.getBoundingClientRect();
  const rowsRect = rowsElement?.getBoundingClientRect() ?? hostRect;
  const width = host.clientWidth || hostRect.width;
  const height = host.clientHeight || hostRect.height;
  const cellHeight = rowsRect.height > 0 && term.rows > 0
    ? rowsRect.height / term.rows
    : height > 0 && term.rows > 0
      ? height / term.rows
      : 0;
  const cellWidth = rowsRect.width > 0 && term.cols > 0
    ? rowsRect.width / term.cols
    : width > 0 && term.cols > 0
      ? width / term.cols
      : 0;

  if (!finitePositive(width) || !finitePositive(height) || !finitePositive(cellHeight) || !finitePositive(cellWidth)) {
    return null;
  }

  return {
    rowTop: rowsRect.top - hostRect.top,
    rowLeft: rowsRect.left - hostRect.left,
    cellWidth,
    cellHeight,
    viewportY: term.buffer.active.viewportY,
    rows: term.rows,
    cols: term.cols,
    width,
    height,
  };
}

export function terminalCellToOverlayPoint(
  metrics: TerminalOverlayMetrics,
  absoluteLine: number,
  col: number,
): { x: number; y: number; visibleRow: number } {
  const visibleRow = absoluteLine - metrics.viewportY;
  return {
    visibleRow,
    y: metrics.rowTop + visibleRow * metrics.cellHeight,
    x: metrics.rowLeft + col * metrics.cellWidth,
  };
}

export function terminalLineRangeToOverlayRange(
  metrics: TerminalOverlayMetrics,
  startLine: number,
  endLine: number,
): TerminalOverlayLineRange | null {
  const viewportStart = metrics.viewportY;
  const viewportEnd = viewportStart + metrics.rows - 1;
  if (endLine < viewportStart || startLine > viewportEnd) return null;

  const visibleStartLine = Math.max(startLine, viewportStart);
  const visibleEndLine = Math.min(endLine, viewportEnd);
  const startPoint = terminalCellToOverlayPoint(metrics, visibleStartLine, 0);
  const endPoint = terminalCellToOverlayPoint(metrics, visibleEndLine, metrics.cols);
  const height = (visibleEndLine - visibleStartLine + 1) * metrics.cellHeight;

  return {
    x: startPoint.x,
    y: startPoint.y,
    width: Math.max(1, endPoint.x - startPoint.x),
    height: Math.max(1, height),
    hasTop: startLine >= viewportStart,
    hasBottom: endLine <= viewportEnd,
    visibleStartLine,
    visibleEndLine,
  };
}

export function buildSelectionOverlayRects(
  range: TerminalOverlayLineRange,
  stale = false,
): TerminalOverlayRect[] {
  const rects: TerminalOverlayRect[] = [
    {
      role: 'selection',
      x: range.x,
      y: range.y,
      width: range.width,
      height: range.height,
      stale,
    },
  ];
  if (range.hasTop) {
    rects.push({
      role: 'selectionTop',
      x: range.x,
      y: range.y,
      width: range.width,
      height: 1,
      stale,
    });
  }
  if (range.hasBottom) {
    rects.push({
      role: 'selectionBottom',
      x: range.x,
      y: Math.max(range.y, range.y + range.height - 1),
      width: range.width,
      height: 1,
      stale,
    });
  }
  return rects;
}

export function prepareTerminalOverlayCanvas(canvas: HTMLCanvasElement, host: HTMLElement): void {
  const style = getComputedStyle(host);
  if (style.position === 'static') {
    host.style.position = 'relative';
  }
  canvas.className = 'xterm-terminal-overlay-canvas';
  canvas.style.position = 'absolute';
  canvas.style.inset = '0';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.pointerEvents = 'none';
  canvas.style.zIndex = '7';
}

function resizeCanvasToHost(canvas: HTMLCanvasElement): { width: number; height: number; dpr: number } {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.floor(rect.width * dpr));
  const height = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  return { width: rect.width, height: rect.height, dpr };
}

function overlayColor(canvas: HTMLCanvasElement, stale: boolean): string {
  const styles = getComputedStyle(canvas);
  if (stale) {
    return styles.getPropertyValue('--theme-text-muted').trim() || 'rgba(148, 163, 184, 0.72)';
  }
  return styles.getPropertyValue('--theme-accent').trim() || '#12cfd0';
}

function drawLineRect(ctx: CanvasRenderingContext2D, rect: TerminalOverlayRect, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(rect.x, rect.y, Math.max(1, rect.width), Math.max(1, rect.height));
}

export function renderTerminalOverlayRects(
  canvas: HTMLCanvasElement,
  rects: readonly TerminalOverlayRect[],
): void {
  const context = canvas.getContext('2d');
  const { width, height, dpr } = resizeCanvasToHost(canvas);
  if (!context) return;

  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);

  for (const rect of rects) {
    const color = overlayColor(canvas, rect.stale === true);
    if (rect.role === 'selection') {
      context.fillStyle = rect.stale ? 'rgba(148, 163, 184, 0.04)' : 'rgba(18, 207, 208, 0.035)';
      context.fillRect(rect.x, rect.y, Math.max(1, rect.width), Math.max(1, rect.height));
      context.fillStyle = color;
      context.fillRect(rect.x, rect.y, 1, Math.max(1, rect.height));
      context.fillRect(Math.max(rect.x, rect.x + rect.width - 1), rect.y, 1, Math.max(1, rect.height));
      continue;
    }
    drawLineRect(context, rect, color);
  }
}
