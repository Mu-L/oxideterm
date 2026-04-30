// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

export type CommandBarCompletionKind =
  | 'history'
  | 'command'
  | 'subcommand'
  | 'option'
  | 'arg'
  | 'path'
  | 'file'
  | 'directory'
  | 'ai'
  | 'quick_command';

export type CommandBarCompletionSource = 'history' | 'fig' | 'path' | 'ai' | 'quick_command';

export type CommandBarCompletionRisk = 'low' | 'medium' | 'high';

export interface CommandBarCompletion {
  kind: CommandBarCompletionKind;
  label: string;
  insertText: string;
  description?: string;
  source: CommandBarCompletionSource;
  executable: boolean;
  replacement: { start: number; end: number };
  score: number;
  inlineSafe?: boolean;
  risk?: CommandBarCompletionRisk;
}

export type CommandBarTerminalType = 'terminal' | 'local_terminal';

export interface CommandBarCompletionContext {
  paneId: string;
  sessionId: string;
  tabId: string;
  terminalType: CommandBarTerminalType;
  nodeId?: string | null;
  cwd?: string | null;
  cwdHost?: string | null;
  targetLabel?: string | null;
}

export interface ShellToken {
  raw: string;
  value: string;
  start: number;
  end: number;
  quote: "'" | '"' | null;
}

export interface ShellParseResult {
  input: string;
  cursorIndex: number;
  reliable: boolean;
  tokens: ShellToken[];
  currentToken: ShellToken;
  currentTokenIndex: number;
  commandName: string | null;
}

export type FigArgType = 'path' | 'file' | 'directory' | null;

export interface CommandBarCompletionProviderArgs {
  input: string;
  cursorIndex: number;
  context: CommandBarCompletionContext;
  parsed: ShellParseResult;
  activeArgType: FigArgType;
  signal: AbortSignal;
  allowEmptyHistory?: boolean;
}

export type CommandBarCompletionProvider = (
  args: CommandBarCompletionProviderArgs,
) => Promise<CommandBarCompletion[]> | CommandBarCompletion[];
