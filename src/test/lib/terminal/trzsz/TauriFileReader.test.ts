import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildTauriFileReaders, TauriFileReader } from '@/lib/terminal/trzsz/TauriFileReader';
import type { TrzszTransferPolicy, TrzszUploadEntryDto } from '@/lib/terminal/trzsz/types';

const apiMock = vi.hoisted(() => ({
  trzszBuildUploadEntries: vi.fn(),
  trzszOpenUploadFile: vi.fn(),
  trzszReadUploadChunk: vi.fn(),
  trzszCloseUploadFile: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: apiMock,
}));

function createEntry(overrides: Partial<TrzszUploadEntryDto> = {}): TrzszUploadEntryDto {
  return {
    pathId: 1,
    path: '/tmp/file.txt',
    relPath: ['file.txt'],
    size: 11,
    isDir: false,
    isSymlink: false,
    ...overrides,
  };
}

function createPolicy(overrides: Partial<TrzszTransferPolicy> = {}): TrzszTransferPolicy {
  return {
    allowDirectory: true,
    maxChunkBytes: 1024 * 1024,
    maxFileCount: 1024,
    maxTotalBytes: 10 * 1024 * 1024 * 1024,
    ...overrides,
  };
}

describe('TauriFileReader', () => {
  beforeEach(() => {
    apiMock.trzszBuildUploadEntries.mockReset();
    apiMock.trzszOpenUploadFile.mockReset();
    apiMock.trzszReadUploadChunk.mockReset();
    apiMock.trzszCloseUploadFile.mockReset();
  });

  it('builds readers for recursive directory uploads and preserves relative paths', async () => {
    apiMock.trzszBuildUploadEntries.mockResolvedValue([
      createEntry({
        pathId: 7,
        path: '/tmp/folder',
        relPath: ['folder'],
        size: 0,
        isDir: true,
      }),
      createEntry({
        pathId: 7,
        path: '/tmp/folder/nested.txt',
        relPath: ['folder', 'nested.txt'],
        size: 23,
      }),
    ]);

    const readers = await buildTauriFileReaders('owner-1', ['/tmp/folder'], true, createPolicy());

    expect(apiMock.trzszBuildUploadEntries).toHaveBeenCalledWith('owner-1', ['/tmp/folder'], true);
    expect(readers).toHaveLength(2);
    expect(readers?.[0]?.isDir()).toBe(true);
    expect(readers?.[0]?.getRelPath()).toEqual(['folder']);
    expect(readers?.[1]?.isDir()).toBe(false);
    expect(readers?.[1]?.getRelPath()).toEqual(['folder', 'nested.txt']);
    expect(readers?.[1]?.getSize()).toBe(23);
  });

  it('opens an upload handle lazily and advances chunk offsets for file reads', async () => {
    apiMock.trzszOpenUploadFile.mockResolvedValue({
      handleId: 'handle-1',
      size: 11,
    });
    apiMock.trzszReadUploadChunk
      .mockResolvedValueOnce(new Uint8Array([104, 101, 108, 108, 111]))
      .mockResolvedValueOnce(new Uint8Array([32, 119, 111, 114, 108, 100]));
    apiMock.trzszCloseUploadFile.mockResolvedValue(undefined);

    const reader = new TauriFileReader('owner-1', createEntry());

    const firstChunk = await reader.readFile(new ArrayBuffer(5));
    const secondChunk = await reader.readFile(new ArrayBuffer(6));
    reader.closeFile();
    reader.closeFile();

    expect(Array.from(firstChunk)).toEqual([104, 101, 108, 108, 111]);
    expect(Array.from(secondChunk)).toEqual([32, 119, 111, 114, 108, 100]);
    expect(apiMock.trzszOpenUploadFile).toHaveBeenCalledTimes(1);
    expect(apiMock.trzszOpenUploadFile).toHaveBeenCalledWith('owner-1', '/tmp/file.txt');
    expect(apiMock.trzszReadUploadChunk).toHaveBeenNthCalledWith(1, 'owner-1', 'handle-1', 0, 5);
    expect(apiMock.trzszReadUploadChunk).toHaveBeenNthCalledWith(2, 'owner-1', 'handle-1', 5, 6);
    expect(apiMock.trzszCloseUploadFile).toHaveBeenCalledTimes(1);
    expect(apiMock.trzszCloseUploadFile).toHaveBeenCalledWith('owner-1', 'handle-1');
  });

  it('does not open handles for directory placeholders', async () => {
    const reader = new TauriFileReader(
      'owner-1',
      createEntry({
        path: '/tmp/folder',
        relPath: ['folder'],
        size: 0,
        isDir: true,
      }),
    );

    const chunk = await reader.readFile(new ArrayBuffer(32));
    reader.closeFile();

    expect(chunk).toEqual(new Uint8Array(0));
    expect(apiMock.trzszOpenUploadFile).not.toHaveBeenCalled();
    expect(apiMock.trzszCloseUploadFile).not.toHaveBeenCalled();
  });

  it('rejects directory uploads when directory transfer is disabled', async () => {
    apiMock.trzszBuildUploadEntries.mockResolvedValue([
      createEntry({
        pathId: 7,
        path: '/tmp/folder',
        relPath: ['folder'],
        size: 0,
        isDir: true,
      }),
      createEntry({
        pathId: 8,
        path: '/tmp/folder/nested.txt',
        relPath: ['folder', 'nested.txt'],
        size: 23,
      }),
    ]);

    await expect(
      buildTauriFileReaders('owner-1', ['/tmp/folder'], true, createPolicy({ allowDirectory: false })),
    ).rejects.toMatchObject({ code: 'directory_not_allowed' });
  });

  it('rejects uploads that exceed the configured file count limit', async () => {
    apiMock.trzszBuildUploadEntries.mockResolvedValue([
      createEntry({ pathId: 1, path: '/tmp/a.txt', relPath: ['a.txt'], size: 10 }),
      createEntry({ pathId: 2, path: '/tmp/b.txt', relPath: ['b.txt'], size: 12 }),
    ]);

    await expect(
      buildTauriFileReaders('owner-1', ['/tmp/a.txt', '/tmp/b.txt'], false, createPolicy({ maxFileCount: 1 })),
    ).rejects.toMatchObject({ code: 'max_file_count_exceeded' });
  });

  it('rejects uploads that exceed the configured total byte limit', async () => {
    apiMock.trzszBuildUploadEntries.mockResolvedValue([
      createEntry({ pathId: 1, path: '/tmp/a.txt', relPath: ['a.txt'], size: 10 }),
      createEntry({ pathId: 2, path: '/tmp/b.txt', relPath: ['b.txt'], size: 12 }),
    ]);

    await expect(
      buildTauriFileReaders('owner-1', ['/tmp/a.txt', '/tmp/b.txt'], false, createPolicy({ maxTotalBytes: 16 })),
    ).rejects.toMatchObject({ code: 'max_total_bytes_exceeded' });
  });
});