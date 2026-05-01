// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import { sanitizeForAi } from '../../contextSanitizer';
import type { ToolExecutionSummary, ToolExecutionTarget } from './types';

const MAX_STDERR_LINES = 3;
const MAX_STDERR_SUMMARY_CHARS = 600;

function clampText(value: string, maxChars = MAX_STDERR_SUMMARY_CHARS): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...[truncated]`;
}

function hasOwn<T extends object, K extends PropertyKey>(
  value: T,
  key: K,
): value is T & Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function summarizeStderr(
  stderr?: string | null,
  fallback?: string | null,
): string | undefined {
  const source = (stderr && stderr.trim()) || (fallback && fallback.trim()) || '';
  if (!source) return undefined;

  const summary = source
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, MAX_STDERR_LINES)
    .join('\n');

  return clampText(sanitizeForAi(summary));
}

export function normalizeExecutionTarget(target?: ToolExecutionTarget | null): ToolExecutionTarget | undefined {
  if (!target?.id) return undefined;
  return {
    id: target.id,
    ...(target.kind ? { kind: target.kind } : {}),
    ...(target.label ? { label: target.label } : {}),
  };
}

export function createExecutionSummary(input: {
  kind?: ToolExecutionSummary['kind'];
  command?: string | null;
  cwd?: string | null;
  target?: ToolExecutionTarget | null;
  exitCode?: number | null;
  timedOut?: boolean;
  truncated?: boolean;
  stderr?: string | null;
  stderrSummary?: string | null;
  errorMessage?: string | null;
  items?: ToolExecutionSummary['items'];
}): ToolExecutionSummary {
  const summary: ToolExecutionSummary = {
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.command ? { command: input.command } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(normalizeExecutionTarget(input.target) ? { target: normalizeExecutionTarget(input.target) } : {}),
    ...(hasOwn(input, 'exitCode') ? { exitCode: input.exitCode ?? null } : {}),
    ...(input.timedOut !== undefined ? { timedOut: input.timedOut } : {}),
    ...(input.truncated !== undefined ? { truncated: input.truncated } : {}),
    ...(input.stderrSummary
      ? { stderrSummary: clampText(sanitizeForAi(input.stderrSummary)) }
      : summarizeStderr(input.stderr, input.errorMessage)
        ? { stderrSummary: summarizeStderr(input.stderr, input.errorMessage) }
        : {}),
    ...(input.items && input.items.length > 0 ? { items: input.items.slice(0, 10) } : {}),
  };

  return summary;
}
