import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRuntimeEventHubForTests } from '@/lib/runtimeEventHub';
import { useSessionTreeStore } from '@/store/sessionTreeStore';
import { resetNodeStateStoreForTests, retainNodeStateBridge } from '@/store/nodeStateStore';

const nodeStateEventMocks = vi.hoisted(() => {
  const listeners = new Map<string, Set<(event: { payload: unknown }) => void>>();
  let deferred = false;
  let pendingResolvers: Array<() => void> = [];

  return {
    listen: vi.fn((eventName: string, callback: (event: { payload: unknown }) => void) => {
      const unlisten = vi.fn(() => {
        listeners.get(eventName)?.delete(callback);
      });

      if (deferred) {
        return new Promise<() => void>((resolve) => {
          pendingResolvers.push(() => {
            const current = listeners.get(eventName) ?? new Set();
            current.add(callback);
            listeners.set(eventName, current);
            resolve(unlisten);
          });
        });
      }

      const current = listeners.get(eventName) ?? new Set();
      current.add(callback);
      listeners.set(eventName, current);
      return Promise.resolve(unlisten);
    }),
    emit<T>(eventName: string, payload: T) {
      for (const callback of listeners.get(eventName) ?? []) {
        callback({ payload });
      }
    },
    count(eventName: string) {
      return listeners.get(eventName)?.size ?? 0;
    },
    setDeferred(value: boolean) {
      deferred = value;
    },
    resolvePending() {
      const resolvers = pendingResolvers;
      pendingResolvers = [];
      resolvers.forEach((resolve) => resolve());
    },
    clear() {
      listeners.clear();
      deferred = false;
      pendingResolvers = [];
      this.listen.mockClear();
    },
  };
});

const nodeGetStateMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/event', () => ({
  listen: nodeStateEventMocks.listen,
}));

vi.mock('@/lib/api', () => ({
  nodeGetState: nodeGetStateMock,
}));

import { useNodeState } from '@/hooks/useNodeState';

describe('useNodeState', () => {
  let releaseBridge: (() => void) | null = null;

  beforeEach(async () => {
    vi.clearAllMocks();
    nodeStateEventMocks.clear();
    await resetRuntimeEventHubForTests();
    resetNodeStateStoreForTests();
    nodeGetStateMock.mockResolvedValue({
      state: { readiness: 'connecting', sftpReady: false },
      generation: 1,
    });
    useSessionTreeStore.setState({ nodes: [{ id: 'node-1' } as any] });
    releaseBridge = retainNodeStateBridge();
  });

  afterEach(async () => {
    releaseBridge?.();
    releaseBridge = null;
    resetNodeStateStoreForTests();
    useSessionTreeStore.setState({ nodes: [] });
    await resetRuntimeEventHubForTests();
    nodeStateEventMocks.clear();
  });

  it('loads the initial snapshot and applies newer events', async () => {
    const { result } = renderHook(() => useNodeState('node-1'));

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.state.readiness).toBe('connecting');
    expect(result.current.generation).toBe(1);

    act(() => {
      nodeStateEventMocks.emit('node:state', {
        type: 'connectionStateChanged',
        nodeId: 'node-1',
        generation: 2,
        state: 'ready',
        reason: '',
      });
    });

    await waitFor(() => expect(result.current.state.readiness).toBe('ready'));
    expect(result.current.generation).toBe(2);
  });

  it('ignores out-of-order events with stale generations', async () => {
    const { result } = renderHook(() => useNodeState('node-1'));

    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => {
      nodeStateEventMocks.emit('node:state', {
        type: 'sftpReady',
        nodeId: 'node-1',
        generation: 3,
        ready: true,
        cwd: '/srv/app',
      });
    });

    await waitFor(() => expect(result.current.state.sftpReady).toBe(true));

    act(() => {
      nodeStateEventMocks.emit('node:state', {
        type: 'connectionStateChanged',
        nodeId: 'node-1',
        generation: 2,
        state: 'error',
        reason: 'stale',
      });
    });

    expect(result.current.generation).toBe(3);
    expect(result.current.state.readiness).toBe('connecting');
    expect(result.current.state.sftpCwd).toBe('/srv/app');
  });

  it('resets state when nodeId becomes undefined', async () => {
    const { result, rerender } = renderHook(({ nodeId }) => useNodeState(nodeId), {
      initialProps: { nodeId: 'node-1' as string | undefined },
    });

    await waitFor(() => expect(result.current.ready).toBe(true));

    rerender({ nodeId: undefined });

    expect(result.current.ready).toBe(false);
    expect(result.current.generation).toBe(0);
    expect(result.current.state).toEqual({ readiness: 'disconnected', sftpReady: false });
  });

  it('keeps state selection pure and leaves cleanup to the app-level bridge', async () => {
    nodeStateEventMocks.setDeferred(true);
    releaseBridge?.();
    releaseBridge = retainNodeStateBridge();
    const { unmount } = renderHook(() => useNodeState('node-1'));

    unmount();
    releaseBridge?.();
    releaseBridge = null;
    nodeStateEventMocks.resolvePending();
    await waitFor(() => expect(nodeStateEventMocks.count('node:state')).toBe(0));
  });
});
