import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReconnectPhase } from '@/store/reconnectOrchestratorStore';

const reconnectConfig = vi.hoisted(() => ({
  enabled: true,
  maxAttempts: 2,
  baseDelayMs: 10,
  maxDelayMs: 20,
}));

const apiMocks = vi.hoisted(() => ({
  nodeListForwards: vi.fn().mockResolvedValue([]),
  probeSingleConnection: vi.fn().mockResolvedValue('not_found'),
  nodeCreateForward: vi.fn().mockResolvedValue(undefined),
}));

const sftpMocks = vi.hoisted(() => ({
  nodeSftpListIncompleteTransfers: vi.fn().mockResolvedValue([]),
  nodeSftpResumeTransfer: vi.fn().mockResolvedValue(undefined),
  nodeGetState: vi.fn().mockResolvedValue({
    state: { readiness: 'ready', sftpReady: false },
    generation: 1,
  }),
}));

const toastMock = vi.hoisted(() => ({
  addToast: vi.fn(),
}));

const slogMock = vi.hoisted(() => vi.fn());

const appStoreMock = vi.hoisted(() => {
  const state = {
    tabs: [] as Array<{ id: string; sessionId?: string; rootPane?: unknown }>,
    updatePaneSessionId: vi.fn(),
  };
  return {
    state,
    store: {
      getState: () => state,
    },
  };
});

const ideStoreMock = vi.hoisted(() => {
  const state = {
    nodeId: null as string | null,
    project: null as { rootPath: string } | null,
    tabs: [] as Array<{ path: string; isDirty?: boolean; content: string | null; originalContent?: string | null }>,
    lastClosedAt: null as number | null,
    openProject: vi.fn().mockResolvedValue(undefined),
    openFile: vi.fn().mockResolvedValue(undefined),
  };

  return {
    state,
    store: {
      getState: () => state,
      setState: (patch: Record<string, unknown>) => Object.assign(state, patch),
    },
  };
});

const treeStoreMock = vi.hoisted(() => {
  const nodes = new Map<string, any>();
  const state = {
    nodes,
    nodeTerminalMap: new Map<string, string[]>(),
    terminalNodeMap: new Map<string, string>(),
    getNode: vi.fn((nodeId: string) => nodes.get(nodeId)),
    getDescendants: vi.fn((nodeId: string) => {
      const result: any[] = [];
      const collect = (parentId: string) => {
        for (const node of nodes.values()) {
          if (node.parentId === parentId) {
            result.push(node);
            collect(node.id);
          }
        }
      };
      collect(nodeId);
      return result;
    }),
    reconnectCascade: vi.fn().mockResolvedValue(['root']),
    clearLinkDown: vi.fn(),
    createTerminalForNode: vi.fn(async (nodeId: string) => `${nodeId}-terminal-new`),
    openSftpForNode: vi.fn().mockResolvedValue('sftp-1'),
  };

  return {
    nodes,
    state,
    store: {
      getState: () => state,
    },
  };
});

vi.mock('@/lib/api', () => ({
  api: apiMocks,
  nodeSftpListIncompleteTransfers: sftpMocks.nodeSftpListIncompleteTransfers,
  nodeSftpResumeTransfer: sftpMocks.nodeSftpResumeTransfer,
  nodeGetState: sftpMocks.nodeGetState,
}));

vi.mock('@/store/sessionTreeStore', () => ({
  useSessionTreeStore: treeStoreMock.store,
}));

vi.mock('@/store/ideStore', () => ({
  useIdeStore: ideStoreMock.store,
}));

vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({
      getReconnect: () => reconnectConfig,
    }),
  },
}));

vi.mock('@/hooks/useToast', () => ({
  useToastStore: {
    getState: () => toastMock,
  },
}));

vi.mock('@/lib/structuredLog', () => ({
  slog: slogMock,
}));

vi.mock('@/i18n', () => ({
  default: {
    t: (key: string) => key,
  },
}));

vi.mock('@/store/appStore', () => ({
  useAppStore: appStoreMock.store,
}));

function makeUnifiedNode(overrides: Record<string, unknown> = {}) {
  return {
    id: 'root',
    parentId: null,
    depth: 0,
    host: 'example.com',
    port: 22,
    username: 'tester',
    displayName: 'Example',
    state: { status: 'connected' },
    hasChildren: false,
    isLastChild: true,
    originType: 'direct',
    terminalSessionId: null,
    sftpSessionId: null,
    sshConnectionId: null,
    runtime: {
      connectionId: null,
      status: 'idle',
      terminalIds: [],
      sftpSessionId: null,
    },
    lineGuides: [],
    isExpanded: false,
    ...overrides,
  };
}

function flushMicrotasks() {
  return Promise.resolve().then(() => Promise.resolve());
}

function makeForwardRule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'forward-1',
    forward_type: 'local',
    bind_address: '127.0.0.1',
    bind_port: 8080,
    target_host: 'localhost',
    target_port: 3000,
    status: 'active',
    description: 'forward',
    ...overrides,
  };
}

async function loadStore() {
  const mod = await import('@/store/reconnectOrchestratorStore');
  return mod.useReconnectOrchestratorStore;
}

describe('reconnectOrchestratorStore', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    reconnectConfig.enabled = true;
    reconnectConfig.maxAttempts = 2;
    reconnectConfig.baseDelayMs = 10;
    reconnectConfig.maxDelayMs = 20;

    treeStoreMock.nodes.clear();
    treeStoreMock.nodes.set(
      'root',
      makeUnifiedNode({
        id: 'root',
        hasChildren: true,
        runtime: { connectionId: 'conn-root', status: 'link-down', terminalIds: [], sftpSessionId: null },
      }),
    );
    treeStoreMock.nodes.set(
      'child',
      makeUnifiedNode({
        id: 'child',
        parentId: 'root',
        depth: 1,
        runtime: { connectionId: 'conn-child', status: 'link-down', terminalIds: [], sftpSessionId: null },
      }),
    );

    treeStoreMock.state.nodeTerminalMap = new Map();
    treeStoreMock.state.terminalNodeMap = new Map();
    appStoreMock.state.tabs = [];
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it('skips scheduling when auto reconnect is disabled', async () => {
    reconnectConfig.enabled = false;
    const store = await loadStore();

    store.getState().scheduleReconnect('root');
    await vi.advanceTimersByTimeAsync(500);
    await flushMicrotasks();

    expect(store.getState().jobs.size).toBe(0);
    expect(treeStoreMock.state.reconnectCascade).not.toHaveBeenCalled();
  });

  it('debounces pending nodes and collapses ancestor and descendant into one root job', async () => {
    const store = await loadStore();

    store.getState().scheduleReconnect('child');
    store.getState().scheduleReconnect('root');

    await vi.advanceTimersByTimeAsync(500);
    await flushMicrotasks();

    expect(treeStoreMock.state.reconnectCascade).toHaveBeenCalledWith('root');
    expect(store.getState().jobs.has('root')).toBe(true);
    expect(store.getState().jobs.has('child')).toBe(false);
    expect(store.getState().getJob('root')?.status).toBe('done');
  });

  it('cancels a running job and all descendant jobs', async () => {
    const store = await loadStore();
    const rootAbort = new AbortController();
    const childAbort = new AbortController();

    store.setState({
      jobs: new Map([
        ['root', {
          nodeId: 'root',
          nodeName: 'Root',
          status: 'ssh-connect',
          attempt: 1,
          maxAttempts: 2,
          startedAt: Date.now(),
          snapshot: {
            nodeId: 'root',
            snapshotAt: Date.now(),
            forwardRules: [],
            oldTerminalSessionIds: [],
            perNodeOldSessionIds: new Map(),
            incompleteTransfers: [],
            oldConnectionIds: new Map(),
          },
          abortController: rootAbort,
          restoredCount: 0,
          phaseHistory: [],
        }],
        ['child', {
          nodeId: 'child',
          nodeName: 'Child',
          status: 'await-terminal',
          attempt: 1,
          maxAttempts: 2,
          startedAt: Date.now(),
          snapshot: {
            nodeId: 'child',
            snapshotAt: Date.now(),
            forwardRules: [],
            oldTerminalSessionIds: [],
            perNodeOldSessionIds: new Map(),
            incompleteTransfers: [],
            oldConnectionIds: new Map(),
          },
          abortController: childAbort,
          restoredCount: 0,
          phaseHistory: [],
        }],
      ]),
      jobEntries: [],
    });

    store.getState().cancel('root');

    expect(store.getState().getJob('root')?.status).toBe('cancelled');
    expect(store.getState().getJob('child')?.status).toBe('cancelled');
    expect(rootAbort.signal.aborted).toBe(true);
    expect(childAbort.signal.aborted).toBe(true);
  });

  it('cancelAll clears debounced pending reconnects before jobs are created', async () => {
    const store = await loadStore();

    store.getState().scheduleReconnect('root');
    store.getState().cancelAll();

    await vi.advanceTimersByTimeAsync(500);
    await flushMicrotasks();

    expect(store.getState().jobs.size).toBe(0);
    expect(treeStoreMock.state.reconnectCascade).not.toHaveBeenCalled();
  });

  it('clearCompleted only removes terminal jobs', async () => {
    const store = await loadStore();
    const jobFactory = (status: ReconnectPhase) => ({
      nodeId: status,
      nodeName: status,
      status,
      attempt: 1,
      maxAttempts: 2,
      startedAt: Date.now(),
      endedAt: Date.now(),
      snapshot: {
        nodeId: status,
        snapshotAt: Date.now(),
        forwardRules: [],
        oldTerminalSessionIds: [],
        perNodeOldSessionIds: new Map(),
        incompleteTransfers: [],
        oldConnectionIds: new Map(),
      },
      abortController: new AbortController(),
      restoredCount: 0,
      phaseHistory: [],
    });

    store.setState({
      jobs: new Map([
        ['done', jobFactory('done')],
        ['failed', jobFactory('failed')],
        ['cancelled', jobFactory('cancelled')],
        ['running', jobFactory('ssh-connect')],
      ]),
      jobEntries: [],
    });

    store.getState().clearCompleted();

    expect(Array.from(store.getState().jobs.keys())).toEqual(['running']);
  });

  it('restores only non-stopped forward rules from the snapshot', async () => {
    treeStoreMock.nodes.clear();
    treeStoreMock.nodes.set(
      'root',
      makeUnifiedNode({
        id: 'root',
        runtime: { connectionId: 'conn-root', status: 'link-down', terminalIds: [], sftpSessionId: null },
      }),
    );
    apiMocks.nodeListForwards
      .mockResolvedValueOnce([
        makeForwardRule({ id: 'active-1', status: 'active', bind_port: 8080 }),
        makeForwardRule({ id: 'stopped-1', status: 'stopped', bind_port: 9090 }),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const store = await loadStore();
    store.getState().scheduleReconnect('root');

    await vi.advanceTimersByTimeAsync(500);
    await flushMicrotasks();

    expect(apiMocks.nodeCreateForward).toHaveBeenCalledTimes(1);
    expect(apiMocks.nodeCreateForward).toHaveBeenCalledWith(
      expect.objectContaining({
        node_id: 'root',
        bind_port: 8080,
      }),
    );
  });

  it('continues restoring later forwards after one restore fails', async () => {
    treeStoreMock.nodes.clear();
    treeStoreMock.nodes.set(
      'root',
      makeUnifiedNode({
        id: 'root',
        runtime: { connectionId: 'conn-root', status: 'link-down', terminalIds: [], sftpSessionId: null },
      }),
    );
    apiMocks.nodeListForwards
      .mockResolvedValueOnce([
        makeForwardRule({ id: 'forward-1', bind_port: 8080, description: 'first' }),
        makeForwardRule({ id: 'forward-2', bind_port: 9090, description: 'second' }),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    apiMocks.nodeCreateForward
      .mockRejectedValueOnce(new Error('bind failed'))
      .mockResolvedValueOnce(undefined);

    const store = await loadStore();
    store.getState().scheduleReconnect('root');

    await vi.advanceTimersByTimeAsync(500);
    await flushMicrotasks();

    expect(apiMocks.nodeCreateForward).toHaveBeenCalledTimes(2);
    expect(apiMocks.nodeCreateForward).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        node_id: 'root',
        bind_port: 9090,
      }),
    );
    expect(store.getState().getJob('root')?.status).toBe('done');
  });
});