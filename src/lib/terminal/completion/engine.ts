// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import { isLikelySecretCommand } from '@/lib/terminal/autosuggest';
import { figProvider, getActiveFigArgType } from './figProvider';
import { historyProvider } from './historyProvider';
import { pathProvider } from './pathProvider';
import { tokenizeCommandLine } from './tokenizer';
import type {
  CommandBarCompletion,
  CommandBarCompletionContext,
  CommandBarCompletionProvider,
  CommandBarCompletionProviderArgs,
} from './types';

const PROVIDER_TIMEOUT_MS = 900;

type CommandBarCompletionOptions = {
  allowEmptyHistory?: boolean;
  historyOnly?: boolean;
};

async function runProvider(
  provider: CommandBarCompletionProvider,
  args: CommandBarCompletionProviderArgs,
): Promise<CommandBarCompletion[]> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<CommandBarCompletion[]>((resolve) => {
    timeoutId = setTimeout(() => resolve([]), PROVIDER_TIMEOUT_MS);
  });

  const result = await Promise.race([
    Promise.resolve(provider(args)).catch(() => []),
    timeout,
  ]);
  if (timeoutId) clearTimeout(timeoutId);
  return args.signal.aborted ? [] : result;
}

function completionKey(completion: CommandBarCompletion): string {
  return [
    completion.source,
    completion.kind,
    completion.insertText,
    completion.replacement.start,
    completion.replacement.end,
  ].join(':');
}

function normalizeAndRank(completions: CommandBarCompletion[]): CommandBarCompletion[] {
  const byKey = new Map<string, CommandBarCompletion>();
  for (const completion of completions) {
    if (isLikelySecretCommand(completion.insertText)) continue;
    const key = completionKey(completion);
    const existing = byKey.get(key);
    if (!existing || completion.score > existing.score) {
      byKey.set(key, completion);
    }
  }

  return [...byKey.values()]
    .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label))
    .slice(0, 24);
}

export async function getCommandBarCompletions(
  input: string,
  cursorIndex: number,
  context: CommandBarCompletionContext,
  signal: AbortSignal,
  options: CommandBarCompletionOptions = {},
): Promise<CommandBarCompletion[]> {
  const parsed = tokenizeCommandLine(input, cursorIndex);
  const activeArgType = getActiveFigArgType(parsed);
  const baseArgs: CommandBarCompletionProviderArgs = {
    input,
    cursorIndex,
    context,
    parsed,
    activeArgType,
    signal,
    allowEmptyHistory: options.allowEmptyHistory,
  };

  const providers: CommandBarCompletionProvider[] = options.historyOnly
    ? [historyProvider]
    : parsed.reliable
    ? [historyProvider, figProvider, pathProvider]
    : [historyProvider];
  const batches = await Promise.all(providers.map((provider) => runProvider(provider, baseArgs)));
  return normalizeAndRank(batches.flat());
}
