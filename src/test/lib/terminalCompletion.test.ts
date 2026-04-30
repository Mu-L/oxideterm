import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  localListDir: vi.fn(),
  nodeSftpListDir: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: {
    localListDir: apiMocks.localListDir,
  },
  nodeSftpListDir: apiMocks.nodeSftpListDir,
}));

vi.mock('@/lib/ai/orchestrator/ledger', () => ({
  getRecentAiCommandRecords: vi.fn(() => []),
}));

import {
  clearCommandBarPathCompletionCache,
  getCommandBarCompletions,
  tokenizeCommandLine,
} from '@/lib/terminal/completion';
import {
  clearTerminalAutosuggestHistory,
  importTerminalAutosuggestCommands,
} from '@/lib/terminal/autosuggest';
import { useQuickCommandsStore } from '@/store/quickCommandsStore';
import type { CommandBarCompletionContext } from '@/lib/terminal/completion';

const localContext: CommandBarCompletionContext = {
  paneId: 'pane-1',
  sessionId: 'session-1',
  tabId: 'tab-1',
  terminalType: 'local_terminal',
  cwd: '/tmp',
};

const remoteContext: CommandBarCompletionContext = {
  paneId: 'pane-1',
  sessionId: 'session-1',
  tabId: 'tab-1',
  terminalType: 'terminal',
  nodeId: 'node-1',
  cwd: '/home/tester',
};

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe('Command Bar completion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearTerminalAutosuggestHistory();
    clearCommandBarPathCompletionCache();
    useQuickCommandsStore.getState().resetDefaults();
    apiMocks.localListDir.mockResolvedValue([]);
    apiMocks.nodeSftpListDir.mockResolvedValue([]);
  });

  it('tokenizes best-effort shell input and marks unclosed quotes unreliable', () => {
    expect(tokenizeCommandLine('git checkout ./src', 16).currentToken.value).toBe('./src');
    expect(tokenizeCommandLine('git "checkout', 5).reliable).toBe(false);
  });

  it('returns executable history completions with risk metadata', async () => {
    importTerminalAutosuggestCommands(['ls -s', 'rm -rf build'], 'local-history');

    const completions = await getCommandBarCompletions('ls', 2, localContext, signal());
    const history = completions.find((completion) => completion.insertText === 'ls -s');

    expect(history).toMatchObject({
      kind: 'history',
      source: 'history',
      executable: true,
      replacement: { start: 0, end: 2 },
    });
  });

  it('does not show the full history or command catalog for empty input', async () => {
    importTerminalAutosuggestCommands(['pwd', 'ls'], 'local-history');

    const completions = await getCommandBarCompletions('', 0, localContext, signal());

    expect(completions).toEqual([]);
  });

  it('can explicitly recall history for empty input without showing the command catalog', async () => {
    importTerminalAutosuggestCommands(['pwd', 'ls'], 'local-history');

    const completions = await getCommandBarCompletions('', 0, localContext, signal(), {
      allowEmptyHistory: true,
      historyOnly: true,
    });

    expect(completions.map((completion) => completion.source)).toEqual(['history', 'history']);
    expect(completions.map((completion) => completion.insertText)).toEqual(['ls', 'pwd']);
  });

  it('returns non-executable Fig-compatible command and option completions', async () => {
    const commandCompletions = await getCommandBarCompletions('gi', 2, localContext, signal());
    expect(commandCompletions.find((completion) => completion.insertText === 'git ')).toMatchObject({
      kind: 'command',
      source: 'fig',
      executable: false,
    });

    const optionCompletions = await getCommandBarCompletions('ls -', 4, localContext, signal());
    expect(optionCompletions.find((completion) => completion.insertText === '-l')).toMatchObject({
      kind: 'option',
      source: 'fig',
      executable: false,
    });
  });

  it('returns executable quick command completions with explicit source metadata', async () => {
    useQuickCommandsStore.getState().upsertCommand({
      name: 'List detailed files',
      command: 'ls -la',
      category: 'files',
      description: 'Quick command test',
    });

    const completions = await getCommandBarCompletions('ls', 2, localContext, signal());
    const quickCommand = completions.find((completion) => (
      completion.source === 'quick_command' && completion.insertText === 'ls -la'
    ));

    expect(quickCommand).toMatchObject({
      kind: 'quick_command',
      source: 'quick_command',
      executable: true,
      replacement: { start: 0, end: 2 },
    });
  });

  it('falls back to history-only completions when parsing is unreliable', async () => {
    importTerminalAutosuggestCommands(['git "checkout main"'], 'local-history');

    const completions = await getCommandBarCompletions('git "ch', 7, localContext, signal());

    expect(completions.every((completion) => completion.source === 'history')).toBe(true);
  });

  it('uses local path completion and caches directory listings', async () => {
    apiMocks.localListDir.mockResolvedValue([
      { name: 'src', path: '/tmp/src', file_type: 'Directory' },
      { name: 'server.log', path: '/tmp/server.log', file_type: 'File' },
    ]);

    const first = await getCommandBarCompletions('ls s', 4, localContext, signal());
    const second = await getCommandBarCompletions('ls s', 4, localContext, signal());

    expect(first.find((completion) => completion.insertText === 'src/')).toMatchObject({
      kind: 'directory',
      source: 'path',
      executable: false,
    });
    expect(second.length).toBeGreaterThan(0);
    expect(apiMocks.localListDir).toHaveBeenCalledTimes(1);
  });

  it('runs remote path completion only for path-like tokens or path-typed Fig args', async () => {
    apiMocks.nodeSftpListDir.mockResolvedValue([
      { name: 'src', path: '/home/tester/src', file_type: 'Directory' },
    ]);

    await getCommandBarCompletions('echo s', 6, remoteContext, signal());
    expect(apiMocks.nodeSftpListDir).not.toHaveBeenCalled();

    const completions = await getCommandBarCompletions('ls s', 4, remoteContext, signal());
    expect(apiMocks.nodeSftpListDir).toHaveBeenCalledWith('node-1', '/home/tester');
    expect(completions.find((completion) => completion.insertText === 'src/')).toBeTruthy();
  });
});
