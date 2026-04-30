import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const commandBarStateMock = vi.hoisted(() => ({
  submitCommand: vi.fn(),
  setValue: vi.fn(),
  setFocused: vi.fn(),
  acceptSuggestion: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('lucide-react', () => ({
  ChevronRight: () => null,
  FilePlay: () => null,
  GitBranch: () => null,
  Radio: () => null,
  SplitSquareHorizontal: () => null,
  SplitSquareVertical: () => null,
  Square: () => null,
  Trash2: () => null,
  Circle: () => null,
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(),
}));

vi.mock('@/hooks/useTerminalCommandBarState', () => ({
  useTerminalCommandBarState: () => ({
    value: 'ls',
    setValue: commandBarStateMock.setValue,
    focused: true,
    setFocused: commandBarStateMock.setFocused,
    suggestions: [
      { command: 'ls -l', source: 'local-history', lastUsedAt: 2, score: 2 },
      { command: 'ls -s', source: 'local-history', lastUsedAt: 1, score: 1 },
    ],
    acceptSuggestion: commandBarStateMock.acceptSuggestion,
    submitCommand: commandBarStateMock.submitCommand,
    cwd: '/tmp',
    targetLabel: 'local',
    chips: {
      broadcastEnabled: false,
      broadcastTargetCount: 0,
      isRecording: false,
      gitBranch: null,
    },
  }),
}));

vi.mock('@/components/layout/TabBarTerminalActions', () => ({
  BroadcastDropdown: () => null,
}));

vi.mock('@/lib/terminalRegistry', () => ({
  getAllEntries: vi.fn(() => []),
}));

vi.mock('@/store/appStore', () => ({
  useAppStore: () => ({
    sessions: new Map(),
    tabs: [{ id: 'tab-1' }],
    splitPane: vi.fn(),
    getPaneCount: vi.fn(() => 1),
  }),
}));

vi.mock('@/store/broadcastStore', () => ({
  useBroadcastStore: (selector: (state: unknown) => unknown) => selector({
    enabled: false,
    targets: new Set<string>(),
    toggleTarget: vi.fn(),
    disable: vi.fn(),
  }),
}));

vi.mock('@/store/localTerminalStore', () => ({
  useLocalTerminalStore: (selector: (state: unknown) => unknown) => selector({
    createTerminal: vi.fn(),
  }),
}));

vi.mock('@/store/recordingStore', () => ({
  useRecordingStore: (selector: (state: unknown) => unknown) => selector({
    openPlayer: vi.fn(),
    stopRecording: vi.fn(),
    discardRecording: vi.fn(),
    isRecording: vi.fn(() => false),
  }),
}));

import { TerminalCommandBar } from '@/components/terminal/TerminalCommandBar';

describe('TerminalCommandBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('submits the highlighted suggestion when Enter is pressed with suggestions open', () => {
    render(
      <TerminalCommandBar
        paneId="pane-1"
        sessionId="session-1"
        tabId="tab-1"
        terminalType="local_terminal"
        isActive
        sendInput={vi.fn()}
        focusTerminal={vi.fn()}
      />,
    );

    const input = screen.getByPlaceholderText('terminal.command_bar.command_placeholder');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(commandBarStateMock.submitCommand).toHaveBeenCalledWith('ls -s');
  });
});
