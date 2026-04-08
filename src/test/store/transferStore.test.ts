import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  sftpPauseTransfer: vi.fn().mockResolvedValue(true),
  sftpResumeTransfer: vi.fn().mockResolvedValue(true),
  sftpCancelTransfer: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/lib/api', () => ({
  api: apiMocks,
}));

vi.mock('@/i18n', () => ({
  default: {
    t: (key: string) => key,
  },
}));

import {
  useTransferStore,
  formatBytes,
  formatSpeed,
  calculateSpeed,
  type TransferItem,
} from '@/store/transferStore';

/** Helper to create a minimal TransferItem for calculateSpeed testing */
function makeTransfer(overrides: Partial<TransferItem> = {}): TransferItem {
  return {
    id: 'tx-1',
    nodeId: 'node-1',
    name: 'file.txt',
    localPath: '/tmp/file.txt',
    remotePath: '/home/user/file.txt',
    direction: 'upload',
    size: 1024,
    transferred: 0,
    state: 'active',
    startTime: Date.now(),
    ...overrides,
  } as TransferItem;
}

function resetTransferStore() {
  useTransferStore.setState({ transfers: new Map() });
}

describe('useTransferStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTransferStore();
  });

  it('keeps paused transfers paused when progress arrives', () => {
    useTransferStore.setState({
      transfers: new Map([['tx-1', makeTransfer({ id: 'tx-1', state: 'paused', size: 500 })]]),
    });

    useTransferStore.getState().updateProgress('tx-1', 250, 500, 42);

    const transfer = useTransferStore.getState().transfers.get('tx-1');
    expect(transfer?.state).toBe('paused');
    expect(transfer?.backendSpeed).toBe(42);
  });

  it('does not mark indeterminate transfers completed when total size is unknown', () => {
    useTransferStore.setState({
      transfers: new Map([['tx-1', makeTransfer({ id: 'tx-1', size: 0, state: 'pending' })]]),
    });

    useTransferStore.getState().updateProgress('tx-1', 2048, 0, 512);

    const transfer = useTransferStore.getState().transfers.get('tx-1');
    expect(transfer?.state).toBe('active');
    expect(transfer?.size).toBe(0);
    expect(transfer?.transferred).toBe(2048);
  });

  it('ignores late progress for transfers that already reached a terminal state', () => {
    useTransferStore.setState({
      transfers: new Map([['tx-1', makeTransfer({ id: 'tx-1', state: 'completed', transferred: 500, size: 500 })]]),
    });

    useTransferStore.getState().updateProgress('tx-1', 250, 500, 42);

    const transfer = useTransferStore.getState().transfers.get('tx-1');
    expect(transfer?.state).toBe('completed');
    expect(transfer?.transferred).toBe(500);
  });

  it('interrupts only active or pending transfers for the selected node', () => {
    useTransferStore.setState({
      transfers: new Map([
        ['active', makeTransfer({ id: 'active', nodeId: 'node-1', state: 'active' })],
        ['pending', makeTransfer({ id: 'pending', nodeId: 'node-1', state: 'pending' })],
        ['paused', makeTransfer({ id: 'paused', nodeId: 'node-1', state: 'paused' })],
        ['other', makeTransfer({ id: 'other', nodeId: 'node-2', state: 'active' })],
      ]),
    });

    useTransferStore.getState().interruptTransfersByNode('node-1', 'lost');

    expect(useTransferStore.getState().transfers.get('active')?.state).toBe('error');
    expect(useTransferStore.getState().transfers.get('pending')?.state).toBe('error');
    expect(useTransferStore.getState().transfers.get('paused')?.state).toBe('paused');
    expect(useTransferStore.getState().transfers.get('other')?.state).toBe('active');
  });

  it('marks a transfer cancelled even if backend cancellation fails', async () => {
    apiMocks.sftpCancelTransfer.mockRejectedValueOnce(new Error('backend failed'));
    useTransferStore.setState({
      transfers: new Map([['tx-1', makeTransfer({ id: 'tx-1', state: 'active' })]]),
    });

    await useTransferStore.getState().cancelTransfer('tx-1');

    expect(apiMocks.sftpCancelTransfer).toHaveBeenCalledWith('tx-1');
    expect(useTransferStore.getState().transfers.get('tx-1')?.state).toBe('cancelled');
  });

  it('pauses and resumes transfers through the backend control APIs', async () => {
    useTransferStore.setState({
      transfers: new Map([['tx-1', makeTransfer({ id: 'tx-1', state: 'active' })]]),
    });

    await useTransferStore.getState().pauseTransfer('tx-1');
    expect(apiMocks.sftpPauseTransfer).toHaveBeenCalledWith('tx-1');
    expect(useTransferStore.getState().transfers.get('tx-1')?.state).toBe('paused');

    await useTransferStore.getState().resumeTransfer('tx-1');
    expect(apiMocks.sftpResumeTransfer).toHaveBeenCalledWith('tx-1');
    expect(useTransferStore.getState().transfers.get('tx-1')?.state).toBe('pending');
  });
});

describe('formatBytes', () => {
  it('formats 0 bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('formats bytes', () => {
    expect(formatBytes(500)).toBe('500.0 B');
  });

  it('formats kilobytes', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  it('formats megabytes', () => {
    expect(formatBytes(1048576)).toBe('1.0 MB');
  });

  it('formats gigabytes', () => {
    expect(formatBytes(1073741824)).toBe('1.0 GB');
  });

  it('formats terabytes', () => {
    expect(formatBytes(1099511627776)).toBe('1.0 TB');
  });
});

describe('formatSpeed', () => {
  it('appends /s suffix', () => {
    expect(formatSpeed(1024)).toBe('1.0 KB/s');
  });

  it('handles zero', () => {
    expect(formatSpeed(0)).toBe('0 B/s');
  });
});

describe('calculateSpeed', () => {
  it('returns 0 for non-active transfers', () => {
    expect(calculateSpeed(makeTransfer({ state: 'completed' }))).toBe(0);
    expect(calculateSpeed(makeTransfer({ state: 'paused' }))).toBe(0);
    expect(calculateSpeed(makeTransfer({ state: 'pending' }))).toBe(0);
  });

  it('prefers backend-reported speed', () => {
    const transfer = makeTransfer({
      state: 'active',
      transferred: 5000,
      backendSpeed: 2048,
      startTime: Date.now() - 10000,
    });
    expect(calculateSpeed(transfer)).toBe(2048);
  });

  it('returns 0 when transferred is 0', () => {
    const transfer = makeTransfer({
      state: 'active',
      transferred: 0,
      startTime: Date.now() - 1000,
    });
    expect(calculateSpeed(transfer)).toBe(0);
  });

  it('calculates frontend speed from elapsed time', () => {
    const transfer = makeTransfer({
      state: 'active',
      transferred: 10000,
      startTime: Date.now() - 2000, // 2 seconds ago
    });
    const speed = calculateSpeed(transfer);
    // 10000 / 2 = 5000 (approximately, allowing for timing variance)
    expect(speed).toBeGreaterThan(4000);
    expect(speed).toBeLessThan(6000);
  });
});
