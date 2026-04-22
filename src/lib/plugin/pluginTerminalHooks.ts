// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

/**
 * Plugin Terminal Hooks
 *
 * Provides pipeline functions for running plugin input interceptors
 * and output processors. Used by TerminalView.tsx.
 *
 * Design:
 * - Input pipeline is synchronous, fail-open (exception → pass original data)
 * - Output pipeline is synchronous, fail-open
 * - Any interceptor returning null suppresses input entirely
 * - Circuit breaker: plugins exceeding error limits are auto-disabled
 * - Time budget: per-hook calls exceeding HOOK_BUDGET_MS emit a warning
 *   and count toward the circuit breaker
 */

import { usePluginStore } from '../../store/pluginStore';
import { trackPluginError } from './pluginLoader';
import { normalizePluginKeyboardEvent } from './pluginHostUi';

/** Maximum time (ms) a single hook handler should take before warning */
const HOOK_BUDGET_MS = 5;
const PROFILE_SAMPLE_LIMIT = 64;
const PROFILE_REPORT_EVERY = 200;
const PROFILE_REPORT_INTERVAL_MS = 5_000;

type HookKind = 'input' | 'output';

type HookProfileStats = {
  count: number;
  slowCount: number;
  totalMs: number;
  maxMs: number;
  samples: number[];
  lastReportedAt: number;
};

function isTerminalHookProfilingEnabled(): boolean {
  if (!import.meta.env.DEV) return false;
  return Boolean(
    (
      globalThis as typeof globalThis & {
        __OXIDE_PROFILE__?: { terminalHooks?: boolean };
      }
    ).__OXIDE_PROFILE__?.terminalHooks,
  );
}

const hookProfileStats = new Map<string, HookProfileStats>();

function getHookProfileKey(kind: HookKind, pluginId: string): string {
  return `${kind}:${pluginId}`;
}

function computeP95(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}

function recordHookProfile(kind: HookKind, pluginId: string, elapsedMs: number, slow: boolean): void {
  if (!isTerminalHookProfilingEnabled()) return;

  const key = getHookProfileKey(kind, pluginId);
  let stats = hookProfileStats.get(key);
  if (!stats) {
    stats = {
      count: 0,
      slowCount: 0,
      totalMs: 0,
      maxMs: 0,
      samples: [],
      lastReportedAt: performance.now(),
    };
    hookProfileStats.set(key, stats);
  }

  stats.count += 1;
  stats.totalMs += elapsedMs;
  stats.maxMs = Math.max(stats.maxMs, elapsedMs);
  if (slow) stats.slowCount += 1;

  if (stats.samples.length >= PROFILE_SAMPLE_LIMIT) {
    stats.samples.shift();
  }
  stats.samples.push(elapsedMs);

  const now = performance.now();
  if (
    stats.count % PROFILE_REPORT_EVERY === 0
    || now - stats.lastReportedAt >= PROFILE_REPORT_INTERVAL_MS
  ) {
    console.debug(
      `[PluginTerminalHooks] ${kind} profile plugin=${pluginId} count=${stats.count} avg=${(stats.totalMs / stats.count).toFixed(2)}ms p95=${computeP95(stats.samples).toFixed(2)}ms max=${stats.maxMs.toFixed(2)}ms slow=${stats.slowCount}`,
    );
    stats.lastReportedAt = now;
  }
}

function schedulePluginUnload(pluginId: string): void {
  import('./pluginLoader').then(({ unloadPlugin }) => unloadPlugin(pluginId));
}

function maybeTripCircuitBreaker(pluginId: string): void {
  if (trackPluginError(pluginId)) {
    schedulePluginUnload(pluginId);
  }
}

function reportSlowHook(kind: HookKind, pluginId: string, elapsedMs: number): void {
  console.warn(
    `[PluginTerminalHooks] ${kind === 'input' ? 'Input interceptor' : 'Output processor'} (plugin: ${pluginId}) took ${elapsedMs.toFixed(1)}ms (budget: ${HOOK_BUDGET_MS}ms)`,
  );
  maybeTripCircuitBreaker(pluginId);
}

function reportHookError(kind: HookKind, pluginId: string, err: unknown): void {
  console.error(
    `[PluginTerminalHooks] ${kind === 'input' ? 'Input interceptor' : 'Output processor'} error (plugin: ${pluginId}):`,
    err,
  );
  maybeTripCircuitBreaker(pluginId);
}

/**
 * Run the input interceptor pipeline.
 *
 * @param data - Raw input string from term.onData
 * @param sessionId - Terminal session ID
 * @param nodeId - Stable node ID for plugin context
 * @returns Modified string, or null if a plugin suppresses input
 */
export function runInputPipeline(data: string, sessionId: string, nodeId?: string): string | null {
  const { inputInterceptors: interceptors } = usePluginStore.getState();
  if (interceptors.length === 0) return data;

  let current: string | null = data;
  const context = { sessionId, nodeId: nodeId ?? sessionId };

  for (const entry of interceptors) {
    if (current === null) return null;

    try {
      const t0 = performance.now();
      current = entry.handler(current, context);
      const elapsed = performance.now() - t0;
      const isSlow = elapsed > HOOK_BUDGET_MS;

      recordHookProfile('input', entry.pluginId, elapsed, isSlow);
      if (isSlow) reportSlowHook('input', entry.pluginId, elapsed);
    } catch (err) {
      reportHookError('input', entry.pluginId, err);
    }
  }

  return current;
}

/**
 * Run the output processor pipeline.
 *
 * @param data - Raw output bytes (copy of MSG_TYPE_DATA payload)
 * @param sessionId - Terminal session ID
 * @param nodeId - Stable node ID for plugin context
 * @returns Modified Uint8Array
 */
export function runOutputPipeline(data: Uint8Array, sessionId: string, nodeId?: string): Uint8Array {
  const { outputProcessors: processors } = usePluginStore.getState();
  if (processors.length === 0) return data;

  let current = data;
  const context = { sessionId, nodeId: nodeId ?? sessionId };

  for (const entry of processors) {
    try {
      const t0 = performance.now();
      current = entry.handler(current, context);
      const elapsed = performance.now() - t0;
      const isSlow = elapsed > HOOK_BUDGET_MS;

      recordHookProfile('output', entry.pluginId, elapsed, isSlow);
      if (isSlow) reportSlowHook('output', entry.pluginId, elapsed);
    } catch (err) {
      reportHookError('output', entry.pluginId, err);
    }
  }

  return current;
}

/**
 * Match a keyboard event against registered plugin shortcuts.
 *
 * Platform normalization: on macOS, `Cmd` (metaKey) is treated as `Ctrl`
 * because plugins declare shortcuts as `Ctrl+X` which should map to `⌘X`
 * on macOS. This matches the convention used by VS Code, iTerm2, etc.
 * Both `event.ctrlKey` and `event.metaKey` are normalized to "ctrl" in the
 * key combo string, so `Ctrl+K` matches both `Cmd+K` on macOS and `Ctrl+K`
 * on Windows/Linux.
 *
 * @returns The handler function if matched, undefined otherwise
 */
export function matchPluginShortcut(event: KeyboardEvent): (() => void) | undefined {
  const { shortcuts } = usePluginStore.getState();
  if (shortcuts.size === 0) return undefined;

  const normalizedKey = normalizePluginKeyboardEvent(event);

  return shortcuts.get(normalizedKey)?.handler;
}
