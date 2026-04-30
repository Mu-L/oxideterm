// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import { FIG_COMPATIBLE_SPECS, FIG_SPEC_BY_NAME, type FigCompatibleSpec } from './figSpecs';
import type {
  CommandBarCompletion,
  CommandBarCompletionProvider,
  FigArgType,
  ShellParseResult,
} from './types';

function matchesPrefix(value: string, query: string): boolean {
  return value.toLowerCase().startsWith(query.toLowerCase());
}

function commandCompletion(spec: FigCompatibleSpec, parsed: ShellParseResult): CommandBarCompletion {
  return {
    kind: 'command',
    label: spec.name,
    insertText: `${spec.name} `,
    description: spec.description,
    source: 'fig',
    executable: false,
    replacement: { start: parsed.currentToken.start, end: parsed.currentToken.end },
    score: 700 + spec.name.length,
    inlineSafe: true,
  };
}

export function getActiveFigArgType(parsed: ShellParseResult): FigArgType {
  if (!parsed.reliable || !parsed.commandName) return null;
  const spec = FIG_SPEC_BY_NAME.get(parsed.commandName);
  if (!spec || parsed.currentTokenIndex <= 0) return null;

  const previous = parsed.tokens[parsed.currentTokenIndex - 1]?.value;
  const optionWithArg = previous
    ? spec.options?.find((option) => option.name === previous && option.args)
    : null;
  if (optionWithArg?.args === 'path' || optionWithArg?.args === 'file' || optionWithArg?.args === 'directory') {
    return optionWithArg.args;
  }

  if (spec.args === 'path' || spec.args === 'file' || spec.args === 'directory') {
    return spec.args;
  }

  return null;
}

export const figProvider: CommandBarCompletionProvider = ({ parsed }) => {
  if (!parsed.reliable) return [];
  const query = parsed.currentToken.value;

  if (parsed.currentTokenIndex <= 0) {
    if (!query) return [];
    return FIG_COMPATIBLE_SPECS
      .filter((spec) => matchesPrefix(spec.name, query))
      .slice(0, 12)
      .map((spec) => commandCompletion(spec, parsed));
  }

  const spec = parsed.commandName ? FIG_SPEC_BY_NAME.get(parsed.commandName) : null;
  if (!spec) return [];

  const completions: CommandBarCompletion[] = [];
  if (query.startsWith('-')) {
    for (const option of spec.options ?? []) {
      if (!matchesPrefix(option.name, query)) continue;
      completions.push({
        kind: 'option',
        label: option.name,
        insertText: option.args ? `${option.name} ` : option.name,
        description: option.description,
        source: 'fig',
        executable: false,
        replacement: { start: parsed.currentToken.start, end: parsed.currentToken.end },
        score: 620 + option.name.length,
        inlineSafe: true,
      });
    }
    return completions.slice(0, 12);
  }

  const alreadyHasSubcommand = parsed.tokens.slice(1, parsed.currentTokenIndex).some((token) => (
    spec.subcommands?.some((subcommand) => subcommand.name === token.value)
  ));
  if (!alreadyHasSubcommand) {
    for (const subcommand of spec.subcommands ?? []) {
      if (query && !matchesPrefix(subcommand.name, query)) continue;
      completions.push({
        kind: 'subcommand',
        label: subcommand.name,
        insertText: `${subcommand.name} `,
        description: subcommand.description,
        source: 'fig',
        executable: false,
        replacement: { start: parsed.currentToken.start, end: parsed.currentToken.end },
        score: 640 + subcommand.name.length,
        inlineSafe: true,
      });
    }
  }

  return completions.slice(0, 12);
};
