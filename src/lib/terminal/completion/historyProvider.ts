// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import { getTerminalAutosuggestCandidates, isLikelySecretCommand } from '@/lib/terminal/autosuggest';
import type { CommandBarCompletion, CommandBarCompletionProvider } from './types';
import { classifyCommandRisk, riskScorePenalty } from './risk';

export const historyProvider: CommandBarCompletionProvider = ({ input, allowEmptyHistory }) => {
  if (!input.trim() && !allowEmptyHistory) return [];
  const candidates = getTerminalAutosuggestCandidates(input, 8);
  return candidates
    .filter((candidate) => !isLikelySecretCommand(candidate.command))
    .map<CommandBarCompletion>((candidate) => {
      const risk = classifyCommandRisk(candidate.command);
      return {
        kind: 'history',
        label: candidate.command,
        insertText: candidate.command,
        source: 'history',
        executable: true,
        replacement: { start: 0, end: input.length },
        score: candidate.score + 1000 - riskScorePenalty(risk),
        inlineSafe: candidate.command.startsWith(input.trimStart()) && risk !== 'high',
        risk,
      };
    });
};
