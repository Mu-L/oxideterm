import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_QUICK_COMMAND_CATEGORIES,
  DEFAULT_QUICK_COMMANDS,
  matchQuickCommandHostPattern,
  useQuickCommandsStore,
} from '@/store/quickCommandsStore';

describe('quickCommandsStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useQuickCommandsStore.setState({
      categories: DEFAULT_QUICK_COMMAND_CATEGORIES,
      commands: DEFAULT_QUICK_COMMANDS,
    });
  });

  it('ships read-only starter commands and enum icons', () => {
    const state = useQuickCommandsStore.getState();

    expect(state.categories.map((category) => category.icon)).toEqual([
      'server',
      'terminal',
      'folder',
      'docker',
      'zap',
    ]);
    expect(state.commands.some((command) => command.command === 'ls -la')).toBe(true);
    expect(state.commands.some((command) => /rm\s+-|systemctl\s+restart/.test(command.command))).toBe(false);
  });

  it('upserts and deletes persisted commands', () => {
    const created = useQuickCommandsStore.getState().upsertCommand({
      name: 'Status',
      command: 'git status',
      category: 'files',
      description: 'Repo status',
    });

    expect(useQuickCommandsStore.getState().commands.find((command) => command.id === created.id)).toMatchObject({
      name: 'Status',
      command: 'git status',
    });

    useQuickCommandsStore.getState().deleteCommand(created.id);

    expect(useQuickCommandsStore.getState().commands.find((command) => command.id === created.id)).toBeUndefined();
  });

  it('matches host patterns against target display fields using wildcard semantics', () => {
    expect(matchQuickCommandHostPattern('*.prod', ['api.prod'])).toBe(true);
    expect(matchQuickCommandHostPattern('root@*', ['root@192.168.1.10'])).toBe(true);
    expect(matchQuickCommandHostPattern('*.prod', ['dev.local'])).toBe(false);
    expect(matchQuickCommandHostPattern(undefined, ['dev.local'])).toBe(true);
  });
});
