import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMutableSelectorStore } from '@/test/helpers/mockStore';
import type { NodeStateSnapshot } from '@/types';
import type { TransferItem } from '@/store/transferStore';

const apiMocks = vi.hoisted(() => ({
  nodeSftpListIncompleteTransfers: vi.fn(),
  nodeSftpResumeTransfer: vi.fn(),
}));

const nodeStateMock = vi.hoisted(() => ({
  value: {
    state: { readiness: 'ready' as const, sftpReady: true },
    ready: true,
    generation: 1,
  } as { state: NodeStateSnapshot['state']; ready: boolean; generation: number },
}));

const transferStoreState = vi.hoisted(() => ({
  getAllTransfers: vi.fn((): TransferItem[] => []),
  clearCompleted: vi.fn(),
  cancelTransfer: vi.fn(),
  removeTransfer: vi.fn(),
  addTransfer: vi.fn(),
  pauseTransfer: vi.fn(),
  resumeTransfer: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  nodeSftpListIncompleteTransfers: apiMocks.nodeSftpListIncompleteTransfers,
  nodeSftpResumeTransfer: apiMocks.nodeSftpResumeTransfer,
}));

vi.mock('@/hooks/useNodeState', () => ({
  useNodeState: () => nodeStateMock.value,
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/store/transferStore', async () => {
  const actual = await vi.importActual<typeof import('@/store/transferStore')>('@/store/transferStore');
  return {
    ...actual,
    useTransferStore: createMutableSelectorStore(transferStoreState),
  };
});

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, options?: Record<string, unknown>) => {
        if (key === 'sftp.queue.incomplete_count') {
          return `incomplete ${String(options?.count ?? 0)}`;
        }
        if (key === 'sftp.queue.active_count') {
          return `active ${String(options?.count ?? 0)}`;
        }
        if (key === 'sftp.queue.clear_done') {
          return 'clear done';
        }
        if (key === 'sftp.queue.resume_tooltip') {
          return 'resume transfer';
        }
        if (key === 'sftp.queue.pause_tooltip') {
          return 'pause transfer';
        }
        if (key === 'sftp.queue.cancel_tooltip') {
          return 'cancel transfer';
        }
        if (key === 'sftp.queue.remove_tooltip') {
          return 'remove transfer';
        }
        return key;
      },
    }),
  };
});

import { TransferQueue, createResumedTransferSeed } from '@/components/sftp/TransferQueue';
import type { IncompleteTransferInfo } from '@/types';

function makeIncompleteTransfer(
  overrides: Partial<IncompleteTransferInfo> = {},
): IncompleteTransferInfo {
  return {
    transfer_id: 'transfer-1',
    transfer_type: 'Download',
    is_directory: false,
    source_path: '/remote/file.txt',
    destination_path: '/local/file.txt',
    transferred_bytes: 5,
    total_bytes: 10,
    status: 'Failed',
    session_id: 'conn-legacy',
    error: 'boom',
    progress_percent: 50,
    can_resume: true,
    ...overrides,
  };
}

function makeTransfer(overrides: Partial<TransferItem> = {}): TransferItem {
  return {
    id: 'tx-1',
    nodeId: 'node-1',
    name: 'file.txt',
    localPath: '/local/file.txt',
    remotePath: '/remote/file.txt',
    direction: 'download',
    size: 10,
    transferred: 5,
    state: 'active',
    startTime: Date.now(),
    ...overrides,
  };
}

describe('TransferQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nodeStateMock.value = {
      state: { readiness: 'ready', sftpReady: true },
      ready: true,
      generation: 1,
    };
    apiMocks.nodeSftpListIncompleteTransfers.mockResolvedValue([]);
    apiMocks.nodeSftpResumeTransfer.mockResolvedValue(undefined);
    transferStoreState.getAllTransfers.mockReturnValue([]);
  });

  it('creates resumed transfer seeds with the active node ID instead of the stored connection ID', () => {
    const seed = createResumedTransferSeed(
      'node-active',
      makeIncompleteTransfer({
        session_id: 'conn-stale',
        transfer_type: 'Upload',
        source_path: '/local/example.txt',
        destination_path: '/remote/example.txt',
      }),
    );

    expect(seed).toEqual({
      id: 'transfer-1',
      nodeId: 'node-active',
      name: 'example.txt',
      localPath: '/local/example.txt',
      remotePath: '/remote/example.txt',
      direction: 'upload',
      size: 10,
    });
  });

  it('loads incomplete transfers only after the node becomes ready', async () => {
    render(<TransferQueue nodeId="node-1" />);

    await waitFor(() => {
      expect(apiMocks.nodeSftpListIncompleteTransfers).toHaveBeenCalledWith('node-1');
    });
  });

  it('skips incomplete transfer loading while the node is not ready', () => {
    nodeStateMock.value = {
      state: { readiness: 'connecting', sftpReady: false },
      ready: true,
      generation: 1,
    };

    render(<TransferQueue nodeId="node-1" />);

    expect(apiMocks.nodeSftpListIncompleteTransfers).not.toHaveBeenCalled();
  });

  it('resumes an incomplete transfer with the active node id and removes it from the incomplete list', async () => {
    apiMocks.nodeSftpListIncompleteTransfers.mockResolvedValue([makeIncompleteTransfer()]);

    render(<TransferQueue nodeId="node-1" />);

    await screen.findByRole('button', { name: 'incomplete 1' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'incomplete 1' }));
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'resume transfer' }));
    });

    await waitFor(() => {
      expect(apiMocks.nodeSftpResumeTransfer).toHaveBeenCalledWith('node-1', 'transfer-1');
    });

    expect(transferStoreState.addTransfer).toHaveBeenCalledWith({
      id: 'transfer-1',
      nodeId: 'node-1',
      name: 'file.txt',
      localPath: '/local/file.txt',
      remotePath: '/remote/file.txt',
      direction: 'download',
      size: 10,
    });

    await waitFor(() => {
      expect(screen.queryByText('file.txt')).not.toBeInTheDocument();
    });
  });

  it('silently ignores incompatible stored transfer payloads', async () => {
    apiMocks.nodeSftpListIncompleteTransfers.mockRejectedValue(new Error('deserialize invalid type'));

    render(<TransferQueue nodeId="node-1" />);

    await waitFor(() => {
      expect(apiMocks.nodeSftpListIncompleteTransfers).toHaveBeenCalledWith('node-1');
    });

    expect(screen.queryByRole('button', { name: 'incomplete 1' })).not.toBeInTheDocument();
  });

  it('routes active and paused item actions through the transfer store', async () => {
    transferStoreState.getAllTransfers.mockReturnValue([
      makeTransfer({ id: 'active-1', state: 'active' }),
      makeTransfer({ id: 'paused-1', state: 'paused', name: 'paused.txt' }),
    ]);

    render(<TransferQueue nodeId="node-1" />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'pause transfer' }));
      fireEvent.click(screen.getByRole('button', { name: 'resume transfer' }));
    });

    expect(transferStoreState.pauseTransfer).toHaveBeenCalledWith('active-1');
    expect(transferStoreState.resumeTransfer).toHaveBeenCalledWith('paused-1');
  });

  it('clears done items and removes finished rows through the expected actions', async () => {
    transferStoreState.getAllTransfers.mockReturnValue([
      makeTransfer({ id: 'done-1', state: 'completed' }),
    ]);

    render(<TransferQueue nodeId="node-1" />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'clear done' }));
    });
    expect(transferStoreState.clearCompleted).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'remove transfer' }));
    });
    expect(transferStoreState.removeTransfer).toHaveBeenCalledWith('done-1');
  });
});
