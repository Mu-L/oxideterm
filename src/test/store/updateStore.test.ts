import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  updateStartResumableInstall,
  relaunch,
  check,
} = vi.hoisted(() => ({
  updateStartResumableInstall: vi.fn(),
  relaunch: vi.fn(),
  check: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: {
    updateStartResumableInstall,
    updateCheckWithChannel: vi.fn(),
    updateCancelResumableInstall: vi.fn(),
  },
}));

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch,
}));

vi.mock('@tauri-apps/plugin-updater', () => ({
  check,
}));

import { useUpdateStore } from '@/store/updateStore';

function resetUpdateStore() {
  localStorage.removeItem('oxide-update-store');
  useUpdateStore.setState({
    lastCheckedAt: null,
    skippedVersion: null,
    lastInstalledVersion: null,
    stage: 'idle',
    newVersion: null,
    currentVersion: null,
    releaseBody: null,
    releaseDate: null,
    downloadedBytes: 0,
    totalBytes: null,
    downloadSpeed: 0,
    etaSeconds: null,
    errorMessage: null,
    resumableTaskId: null,
    attempt: 0,
    retryDelayMs: null,
  });
}

describe('updateStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetUpdateStore();
  });

  afterEach(() => {
    resetUpdateStore();
  });

  it('does not start another download while one is already in progress', async () => {
    let resolveTask: (value: string) => void;
    const pendingTask = new Promise<string>((resolve) => {
      resolveTask = resolve;
    });
    updateStartResumableInstall.mockReturnValue(pendingTask);

    useUpdateStore.setState({
      stage: 'available',
      newVersion: '1.2.3',
    });

    const firstStart = useUpdateStore.getState().startDownload();
    await Promise.resolve();
    const secondStart = useUpdateStore.getState().startDownload();

    expect(updateStartResumableInstall).toHaveBeenCalledTimes(1);

    resolveTask!('task-1');
    await firstStart;
    await secondStart;

    expect(useUpdateStore.getState().resumableTaskId).toBe('task-1');
  });
});
