// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import type { CommandBarCompletionRisk } from './types';

const HIGH_RISK_PATTERNS = [
  /\brm\s+-(?:[^\s]*r[^\s]*f|[^\s]*f[^\s]*r)\b/i,
  /\bkubectl\s+delete\b/i,
  /\bsystemctl\s+(?:stop|restart|disable|kill)\b/i,
  /\bdocker\s+(?:rm|rmi|system\s+prune|container\s+prune|volume\s+prune|network\s+prune)\b/i,
  /\b(?:shutdown|reboot|halt|poweroff)\b/i,
  /\bkill(?:all)?\s+-9\b/i,
  /\bmkfs(?:\.[^\s]+)?\b/i,
  /\bdd\s+.*\bof=/i,
  /\bchmod\s+-R\b/i,
  /\bchown\s+-R\b/i,
];

const MEDIUM_RISK_PATTERNS = [
  /\bsudo\b/i,
  /\bchmod\s+(?:-R\s+)?777\b/i,
];

export function classifyCommandRisk(command: string): CommandBarCompletionRisk | undefined {
  if (HIGH_RISK_PATTERNS.some((pattern) => pattern.test(command))) return 'high';
  if (MEDIUM_RISK_PATTERNS.some((pattern) => pattern.test(command))) return 'medium';
  return undefined;
}

export function riskScorePenalty(risk: CommandBarCompletionRisk | undefined): number {
  if (risk === 'high') return 900;
  if (risk === 'medium') return 250;
  return 0;
}
