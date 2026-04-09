import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMutableSelectorStore } from '@/test/helpers/mockStore';

const confirmMock = vi.hoisted(() => vi.fn<() => Promise<boolean>>());

const appStoreState = vi.hoisted(() => ({
  tabs: [
    { id: 'tab-1', type: 'terminal', title: 'SSH 1', sessionId: 'session-1' },
  ],
  activeTabId: 'tab-1' as string | null,
  networkOnline: true,
  setActiveTab: vi.fn(),
  closeTab: vi.fn(),
  closeTerminalSession: vi.fn().mockResolvedValue(undefined),
  moveTab: vi.fn(),
  sessions: new Map([
    ['session-1', { id: 'session-1', name: 'SSH 1', connectionId: 'conn-1' }],
  ]),
  connections: new Map([
    ['conn-1', { id: 'conn-1', state: 'active' }],
  ]),
}));

const sessionTreeStoreState = vi.hoisted(() => ({
  terminalNodeMap: new Map([['session-1', 'node-1']]),
  closeTerminalForNode: vi.fn().mockResolvedValue(undefined),
}));

const reconnectStoreState = vi.hoisted(() => ({
  scheduleReconnect: vi.fn(),
  cancel: vi.fn(),
  getJob: vi.fn().mockReturnValue(undefined),
}));

const localTerminalStoreState = vi.hoisted(() => ({
  checkChildProcesses: vi.fn().mockResolvedValue(false),
  closeTerminal: vi.fn().mockResolvedValue(undefined),
  detachTerminal: vi.fn().mockResolvedValue(undefined),
}));

const pluginStoreState = vi.hoisted(() => ({
  contextMenuItems: [],
}));

vi.mock('@/store/appStore', () => ({
  useAppStore: createMutableSelectorStore(appStoreState),
}));

vi.mock('@/store/sessionTreeStore', () => ({
  useSessionTreeStore: createMutableSelectorStore(sessionTreeStoreState),
}));

vi.mock('@/store/reconnectOrchestratorStore', () => ({
  useReconnectOrchestratorStore: createMutableSelectorStore(reconnectStoreState),
}));

vi.mock('@/store/localTerminalStore', () => ({
  useLocalTerminalStore: createMutableSelectorStore(localTerminalStoreState),
}));

vi.mock('@/store/pluginStore', () => ({
  usePluginStore: createMutableSelectorStore(pluginStoreState),
}));

vi.mock('@/lib/topologyResolver', () => ({
  topologyResolver: {
    getNodeId: vi.fn().mockReturnValue('node-1'),
  },
}));

vi.mock('@/lib/plugin/pluginIconResolver', () => ({
  resolvePluginIcon: () => () => null,
}));

vi.mock('@/lib/plugin/pluginHostUi', () => ({
  selectVisiblePluginContextMenuItems: () => [],
}));

vi.mock('@/components/connections/ReconnectTimeline', () => ({
  ReconnectTimeline: () => null,
}));

vi.mock('@/components/layout/TabBarTerminalActions', () => ({
  TabBarTerminalActions: () => null,
}));

vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuItem: ({ children, onSelect }: { children: React.ReactNode; onSelect?: () => void }) => (
    <button onClick={onSelect}>{children}</button>
  ),
  ContextMenuSeparator: () => null,
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/hooks/useConfirm', () => ({
  useConfirm: () => ({
    confirm: confirmMock,
    ConfirmDialog: null,
  }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import { TabBar } from '@/components/layout/TabBar';

describe('TabBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    confirmMock.mockResolvedValue(true);
    appStoreState.closeTab.mockClear();
    appStoreState.closeTerminalSession.mockResolvedValue(undefined);
    sessionTreeStoreState.closeTerminalForNode.mockResolvedValue(undefined);
    appStoreState.tabs = [
      { id: 'tab-1', type: 'terminal', title: 'SSH 1', sessionId: 'session-1' },
    ];
    appStoreState.activeTabId = 'tab-1';
    appStoreState.sessions = new Map([
      ['session-1', { id: 'session-1', name: 'SSH 1', connectionId: 'conn-1' }],
    ]);
    appStoreState.connections = new Map([
      ['conn-1', { id: 'conn-1', state: 'active' }],
    ]);
    sessionTreeStoreState.terminalNodeMap = new Map([['session-1', 'node-1']]);

    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });

    (globalThis as typeof globalThis & { ResizeObserver?: typeof ResizeObserver }).ResizeObserver = class {
      observe() {}
      disconnect() {}
      unobserve() {}
    } as unknown as typeof ResizeObserver;
  });

  it('asks for confirmation before middle-click closing an SSH terminal tab', async () => {
    confirmMock.mockResolvedValue(false);

    render(<TabBar />);
    fireEvent.mouseDown(screen.getByText('SSH 1').parentElement!, { button: 1 });

    await waitFor(() => {
      expect(confirmMock).toHaveBeenCalledWith({
        title: 'tabbar.confirm_close_terminal_title',
        description: 'tabbar.confirm_close_terminal_desc',
        variant: 'danger',
      });
    });

    expect(appStoreState.closeTerminalSession).not.toHaveBeenCalled();
    expect(sessionTreeStoreState.closeTerminalForNode).not.toHaveBeenCalled();
    expect(appStoreState.closeTab).not.toHaveBeenCalled();
  });

  it('closes the SSH terminal tab after confirmation', async () => {
    confirmMock.mockResolvedValue(true);

    render(<TabBar />);
    fireEvent.mouseDown(screen.getByText('SSH 1').parentElement!, { button: 1 });

    await waitFor(() => {
      expect(appStoreState.closeTerminalSession).toHaveBeenCalledWith('session-1');
      expect(sessionTreeStoreState.closeTerminalForNode).toHaveBeenCalledWith('node-1', 'session-1');
      expect(appStoreState.closeTab).toHaveBeenCalledWith('tab-1');
    });
  });

  it('confirms once before closing SSH tabs to the right', async () => {
    confirmMock.mockResolvedValue(true);
    appStoreState.tabs = [
      { id: 'tab-1', type: 'settings', title: 'Settings' },
      { id: 'tab-2', type: 'terminal', title: 'SSH 2', sessionId: 'session-2' },
    ];
    appStoreState.activeTabId = 'tab-1';
    appStoreState.sessions = new Map([
      ['session-2', { id: 'session-2', name: 'SSH 2', connectionId: 'conn-2' }],
    ]);
    appStoreState.connections = new Map([
      ['conn-2', { id: 'conn-2', state: 'active' }],
    ]);
    sessionTreeStoreState.terminalNodeMap = new Map([['session-2', 'node-2']]);

    render(<TabBar />);
    fireEvent.click(screen.getAllByText('tabbar.close_tabs_to_right')[0]);

    await waitFor(() => {
      expect(confirmMock).toHaveBeenCalledWith({
        title: 'tabbar.confirm_close_tabs_to_right_title',
        description: 'tabbar.confirm_close_tabs_to_right_desc',
        variant: 'danger',
      });
      expect(appStoreState.closeTerminalSession).toHaveBeenCalledWith('session-2');
      expect(sessionTreeStoreState.closeTerminalForNode).toHaveBeenCalledWith('node-2', 'session-2');
      expect(appStoreState.closeTab).toHaveBeenCalledWith('tab-2');
    });
  });

  it('keeps the SSH tab open when backend close fails', async () => {
    confirmMock.mockResolvedValue(true);
    appStoreState.closeTerminalSession.mockRejectedValueOnce(new Error('close failed'));

    render(<TabBar />);
    fireEvent.mouseDown(screen.getByText('SSH 1').parentElement!, { button: 1 });

    await waitFor(() => {
      expect(appStoreState.closeTerminalSession).toHaveBeenCalledWith('session-1');
    });

    expect(sessionTreeStoreState.closeTerminalForNode).not.toHaveBeenCalled();
    expect(appStoreState.closeTab).not.toHaveBeenCalled();
  });
});