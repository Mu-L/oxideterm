// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

export { getCommandBarCompletions } from './engine';
export { figProvider, getActiveFigArgType } from './figProvider';
export { pathProvider, clearCommandBarPathCompletionCache } from './pathProvider';
export { historyProvider } from './historyProvider';
export { tokenizeCommandLine } from './tokenizer';
export type {
  CommandBarCompletion,
  CommandBarCompletionContext,
  CommandBarCompletionKind,
  CommandBarCompletionSource,
  CommandBarTerminalType,
  ShellParseResult,
  ShellToken,
} from './types';
