import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const terminalRegistryMocks = vi.hoisted(() => ({
  beginTerminalCommandMark: vi.fn(),
  broadcastToTargets: vi.fn(),
  subscribeTerminalOutput: vi.fn(() => vi.fn()),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) => selector({
    settings: {
      terminal: {
        commandBar: {
          enabled: true,
          gitStatus: false,
        },
      },
    },
  }),
}));

vi.mock('@/store/broadcastStore', () => {
  const state = {
    enabled: false,
    targets: new Set<string>(),
  };
  return {
    useBroadcastStore: Object.assign(
      (selector: (candidate: typeof state) => unknown) => selector(state),
      { getState: () => state },
    ),
  };
});

vi.mock('@/store/recordingStore', () => ({
  useRecordingStore: (selector: (state: { isRecording: () => boolean }) => unknown) => selector({
    isRecording: () => false,
  }),
}));

vi.mock('@/store/appStore', () => ({
  useAppStore: (selector: (state: { sessions: Map<string, unknown>; tabs: unknown[] }) => unknown) => selector({
    sessions: new Map([['session-1', { username: 'user', host: 'host' }]]),
    tabs: [],
  }),
}));

vi.mock('@/lib/api', () => ({
  api: {
    localExecCommand: vi.fn(),
  },
}));

vi.mock('@/lib/terminalRegistry', () => ({
  getCwd: vi.fn(() => '/tmp'),
  getCwdHost: vi.fn(() => null),
  getTerminalBuffer: vi.fn(() => ''),
  beginTerminalCommandMark: terminalRegistryMocks.beginTerminalCommandMark,
  broadcastToTargets: terminalRegistryMocks.broadcastToTargets,
  subscribeTerminalOutput: terminalRegistryMocks.subscribeTerminalOutput,
}));

vi.mock('@/lib/terminal/autosuggest', () => ({
  getTerminalAutosuggestCandidates: vi.fn(() => []),
}));

import { useTerminalCommandBarState } from '@/hooks/useTerminalCommandBarState';

describe('useTerminalCommandBarState', () => {
  it('submits an explicit suggestion command instead of the typed input', () => {
    const sendInput = vi.fn();
    const { result } = renderHook(() => useTerminalCommandBarState({
      paneId: 'pane-1',
      sessionId: 'session-1',
      tabId: 'tab-1',
      terminalType: 'local_terminal',
      isActive: true,
      sendInput,
    }));

    act(() => {
      result.current.setValue('ls');
    });

    act(() => {
      expect(result.current.submitCommand('ls -s')).toBe(true);
    });

    expect(sendInput).toHaveBeenCalledWith('ls -s\r');
    expect(terminalRegistryMocks.beginTerminalCommandMark).toHaveBeenCalledWith('pane-1', {
      command: 'ls -s',
      source: 'command_bar',
      sessionId: 'session-1',
      cwd: '/tmp',
    });
    expect(result.current.value).toBe('');
  });
});
