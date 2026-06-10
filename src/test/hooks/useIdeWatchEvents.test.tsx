import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMutableSelectorStore } from '@/test/helpers/mockStore';

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
}

const watchDirectoryMock = vi.hoisted(() => vi.fn());
const storeState = vi.hoisted(() => ({
  refreshTreeNode: vi.fn(),
}));
const gitRefreshMock = vi.hoisted(() => vi.fn());
const searchCacheClearMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/agentService', () => ({
  watchDirectory: watchDirectoryMock,
}));

vi.mock('@/store/ideStore', () => {
  const useIdeStore = createMutableSelectorStore(storeState);
  return {
    useIdeStore,
    triggerGitRefresh: gitRefreshMock,
    triggerSearchCacheClear: searchCacheClearMock,
  };
});

import { useIdeWatchEvents } from '@/components/ide/hooks/useIdeWatchEvents';

describe('useIdeWatchEvents', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  it('refreshes parent paths and git/search state when watch events arrive', async () => {
    let onEvent: ((event: { path: string; kind: string }) => void) | undefined;
    watchDirectoryMock.mockImplementation(async (_nodeId: string, _path: string, callback: typeof onEvent) => {
      onEvent = callback;
      return vi.fn(async () => undefined);
    });

    renderHook(() => useIdeWatchEvents({
      nodeId: 'node-1',
      rootPath: '/srv/app',
      enabled: true,
      mode: 'agent',
    }));

    expect(watchDirectoryMock).toHaveBeenCalledWith('node-1', '/srv/app', expect.any(Function));

    act(() => {
      onEvent?.({ path: '/srv/app/src/main.ts', kind: 'modify' });
      onEvent?.({ path: '/srv/app/src/utils/helper.ts', kind: 'create' });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(storeState.refreshTreeNode).toHaveBeenCalledWith('/srv/app/src');
    expect(gitRefreshMock).toHaveBeenCalledTimes(1);
    expect(searchCacheClearMock).toHaveBeenCalledTimes(1);
  });

  it('coalesces hidden-directory delete bursts to the visible parent', async () => {
    let onEvent: ((event: { path: string; kind: string }) => void) | undefined;
    watchDirectoryMock.mockImplementation(async (_nodeId: string, _path: string, callback: typeof onEvent) => {
      onEvent = callback;
      return vi.fn(async () => undefined);
    });

    renderHook(() => useIdeWatchEvents({
      nodeId: 'node-1',
      rootPath: '/srv/app',
      enabled: true,
      mode: 'agent',
    }));

    act(() => {
      onEvent?.({ path: '/srv/app/lab/.git/config', kind: 'delete' });
      onEvent?.({ path: '/srv/app/lab/.git/objects/aa/bb', kind: 'delete' });
      onEvent?.({ path: '/srv/app/lab/.git/refs/heads/main', kind: 'delete' });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(storeState.refreshTreeNode).toHaveBeenCalledTimes(1);
    expect(storeState.refreshTreeNode).toHaveBeenCalledWith('/srv/app/lab');
    expect(gitRefreshMock).toHaveBeenCalledTimes(1);
    expect(searchCacheClearMock).toHaveBeenCalledTimes(1);

    act(() => {
      onEvent?.({ path: '/srv/app/lab/.git/index', kind: 'delete' });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(storeState.refreshTreeNode).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(storeState.refreshTreeNode).toHaveBeenCalledTimes(2);
    expect(storeState.refreshTreeNode).toHaveBeenLastCalledWith('/srv/app/lab');
  });

  it('re-establishes watching when agent mode returns after a disconnect', async () => {
    const unlisten = vi.fn(async () => undefined);
    watchDirectoryMock.mockResolvedValue(unlisten);

    const { rerender, unmount } = renderHook(
      ({ mode }) => useIdeWatchEvents({
        nodeId: 'node-1',
        rootPath: '/srv/app',
        enabled: mode === 'agent',
        mode,
      }),
      {
        initialProps: { mode: 'agent' as 'agent' | 'sftp' },
      },
    );

    await act(async () => {
      await flushAsyncWork();
    });

    expect(watchDirectoryMock).toHaveBeenCalledTimes(1);

    rerender({ mode: 'sftp' });
    await act(async () => {
      await flushAsyncWork();
    });

    expect(unlisten).toHaveBeenCalledTimes(1);

    rerender({ mode: 'agent' });
    await act(async () => {
      await flushAsyncWork();
    });

    expect(watchDirectoryMock).toHaveBeenCalledTimes(2);

    unmount();
    await act(async () => {
      await flushAsyncWork();
    });

    expect(unlisten).toHaveBeenCalledTimes(2);
  }, 10000);
});
