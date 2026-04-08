import { describe, expect, it, vi } from 'vitest';
import {
  cleanupPreviewResource,
  findTransferForProgressEvent,
  getTransferCompletionRefreshPlan,
  normalizeSftpTransferPath,
} from '@/components/sftp/sftpViewHelpers';
import type { TransferItem } from '@/store/transferStore';

function makeTransfer(overrides: Partial<TransferItem> = {}): TransferItem {
  return {
    id: 'tx-1',
    nodeId: 'node-1',
    name: 'file.txt',
    localPath: '/local/file.txt',
    remotePath: '/remote/file.txt',
    direction: 'download',
    size: 10,
    transferred: 0,
    state: 'pending',
    startTime: Date.now(),
    ...overrides,
  };
}

describe('sftpViewHelpers', () => {
  it('normalizes repeated separators and preserves root paths', () => {
    expect(normalizeSftpTransferPath('/foo//bar/')).toBe('/foo/bar');
    expect(normalizeSftpTransferPath('/')).toBe('/');
  });

  it('matches transfer progress by exact id first', () => {
    const transfer = makeTransfer();

    const match = findTransferForProgressEvent([transfer], {
      id: 'tx-1',
      local_path: '/other/local.txt',
      remote_path: '/other/remote.txt',
    });

    expect(match?.id).toBe('tx-1');
  });

  it('falls back to exact local and remote path match when id differs', () => {
    const transfer = makeTransfer({ id: 'tx-2' });

    const match = findTransferForProgressEvent([transfer], {
      id: 'backend-id',
      local_path: '/local/file.txt',
      remote_path: '/remote/file.txt',
    });

    expect(match?.id).toBe('tx-2');
  });

  it('does not pick an ambiguous single-path fallback candidate', () => {
    const transfers = [
      makeTransfer({ id: 'tx-1', localPath: '/shared/file.txt', remotePath: '/remote/one.txt' }),
      makeTransfer({ id: 'tx-2', localPath: '/shared/file.txt', remotePath: '/remote/two.txt' }),
    ];

    const match = findTransferForProgressEvent(transfers, {
      id: 'backend-id',
      local_path: '/shared/file.txt',
      remote_path: '/remote/missing.txt',
    });

    expect(match).toBeUndefined();
  });

  it('refreshes only the affected pane when completion direction is known', () => {
    expect(getTransferCompletionRefreshPlan('upload')).toEqual({
      refreshLocal: false,
      refreshRemote: true,
    });
    expect(getTransferCompletionRefreshPlan('download')).toEqual({
      refreshLocal: true,
      refreshRemote: false,
    });
    expect(getTransferCompletionRefreshPlan()).toEqual({
      refreshLocal: true,
      refreshRemote: true,
    });
  });

  it('cleans up preview temp resources when present', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);

    await cleanupPreviewResource({ tempPath: '/tmp/preview.bin' }, cleanup);

    expect(cleanup).toHaveBeenCalledWith('/tmp/preview.bin');
  });

  it('swallows preview cleanup failures so close flows keep working', async () => {
    const cleanup = vi.fn().mockRejectedValue(new Error('nope'));

    await expect(
      cleanupPreviewResource({ tempPath: '/tmp/preview.bin' }, cleanup),
    ).resolves.toBeUndefined();
  });
});