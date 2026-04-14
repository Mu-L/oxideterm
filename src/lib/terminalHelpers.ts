// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import type React from 'react';
import type { BackgroundFit } from '../store/settingsStore';

/**
 * Convert 6-digit hex (#RRGGBB) to rgba() string.
 * xterm.js only parses #hex and rgba() formats — CSS keywords like
 * 'transparent' are NOT recognised and silently fall back to opaque black.
 */
export function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Map BackgroundFit to CSS properties */
export function getBackgroundFitStyles(fit: BackgroundFit): React.CSSProperties {
  switch (fit) {
    case 'cover':
      return { objectFit: 'cover', width: '100%', height: '100%' };
    case 'contain':
      return { objectFit: 'contain', width: '100%', height: '100%' };
    case 'fill':
      return { objectFit: 'fill', width: '100%', height: '100%' };
    case 'tile':
      return {};
  }
}

/**
 * Detect if the GPU is low-end (integrated graphics).
 * Returns true if we should cap blur to ≤5px for performance.
 * Uses WEBGL_debug_renderer_info when available.
 */
let _gpuDetectionResult: boolean | null = null;
export function isLowEndGPU(): boolean {
  if (_gpuDetectionResult !== null) return _gpuDetectionResult;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (gl && gl instanceof WebGLRenderingContext) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) {
        const renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string;
        const low = /Intel|Mesa|SwiftShader|llvmpipe|Apple GPU/i.test(renderer);
        _gpuDetectionResult = low;
        return low;
      }
    }
  } catch { /* noop */ }
  _gpuDetectionResult = false;
  return false;
}

/**
 * Force xterm's internal DOM elements to transparent background.
 * Must be called after `term.open()`, after renderer restore, and after
 * any `term.options.theme = ...` assignment — xterm re-renders the
 * viewport from the parsed theme color on all of these occasions.
 */
export function forceViewportTransparent(container: HTMLElement | null): void {
  if (!container) return;
  const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
  if (viewport) viewport.style.backgroundColor = 'transparent';
  const xtermEl = container.querySelector('.xterm') as HTMLElement | null;
  if (xtermEl) xtermEl.style.backgroundColor = 'transparent';
}

/** Clear DOM-level transparency overrides so xterm reverts to theme-driven background. */
export function clearViewportTransparent(container: HTMLElement | null): void {
  if (!container) return;
  const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
  if (viewport) viewport.style.backgroundColor = '';
  const xtermEl = container.querySelector('.xterm') as HTMLElement | null;
  if (xtermEl) xtermEl.style.backgroundColor = '';
}

export interface TerminalDimensions {
  cols: number;
  rows: number;
}

/**
 * Hidden tab panels collapse terminal containers to zero size. Fitting xterm in
 * that state would incorrectly shrink the backing PTY and corrupt prompt layout.
 */
export function isTerminalContainerRenderable(container: HTMLElement | null): boolean {
  if (!container || !container.isConnected) return false;
  const rect = container.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * Use freshly measured dimensions when the terminal is visible. Otherwise keep
 * the last stable xterm size instead of accepting hidden-tab measurements.
 */
export function resolveTerminalDimensions(
  container: HTMLElement | null,
  terminal: TerminalDimensions | null,
  fitAddon: { proposeDimensions: () => TerminalDimensions | null | undefined } | null,
): TerminalDimensions | null {
  const proposed = isTerminalContainerRenderable(container)
    ? fitAddon?.proposeDimensions() ?? null
    : null;
  const candidate = proposed ?? terminal;
  if (!candidate) return null;
  const { cols, rows } = candidate;
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) {
    return null;
  }
  return { cols, rows };
}
