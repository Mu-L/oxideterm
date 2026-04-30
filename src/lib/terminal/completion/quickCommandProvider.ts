// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import { useQuickCommandsStore, matchQuickCommandHostPattern } from '@/store/quickCommandsStore';
import { useSettingsStore } from '@/store/settingsStore';
import type { CommandBarCompletion, CommandBarCompletionProvider } from './types';
import { classifyCommandRisk, riskScorePenalty } from './risk';

function includesQuery(value: string | undefined, query: string): boolean {
  return !!value && value.toLowerCase().includes(query);
}

export const quickCommandProvider: CommandBarCompletionProvider = ({ input, context }) => {
  const settings = useSettingsStore.getState().settings.terminal.commandBar;
  if (!settings.quickCommandsEnabled) return [];

  const query = input.trim().toLowerCase();
  if (!query) return [];

  const targetFields = [
    context.targetLabel,
    context.cwdHost,
    context.nodeId,
  ];

  return useQuickCommandsStore.getState().commands
    .filter((command) => (
      matchQuickCommandHostPattern(command.hostPattern, targetFields)
      && (
        includesQuery(command.name, query)
        || includesQuery(command.command, query)
        || includesQuery(command.description, query)
      )
    ))
    .map<CommandBarCompletion>((command) => {
      const risk = classifyCommandRisk(command.command);
      const startsWithInput = command.command.toLowerCase().startsWith(input.trimStart().toLowerCase());
      return {
        kind: 'quick_command',
        label: command.command,
        insertText: command.command,
        description: command.name,
        source: 'quick_command',
        executable: true,
        replacement: { start: 0, end: input.length },
        score: 860 - riskScorePenalty(risk),
        inlineSafe: startsWithInput && risk !== 'high',
        risk,
      };
    })
    .slice(0, 8);
};
