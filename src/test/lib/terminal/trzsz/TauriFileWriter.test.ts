import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTauriOpenSaveFile } from '@/lib/terminal/trzsz/TauriFileWriter';
import type { TrzszSaveRoot, TrzszTransferPolicy } from '@/lib/terminal/trzsz/types';

const apiMock = vi.hoisted(() => ({
  trzszOpenSaveFile: vi.fn(),
  trzszWriteDownloadChunk: vi.fn(),
  trzszFinishDownloadFile: vi.fn(),
  trzszAbortDownloadFile: vi.fn(),
  trzszCreateDownloadDirectory: vi.fn(),
  trzszCommitDownloadDirectory: vi.fn(),
  trzszRemoveDownloadDirectory: vi.fn(),
  trzszRemoveDownloadFile: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: apiMock,
}));

function createSaveRoot(): TrzszSaveRoot {
  return {
    rootPath: '/downloads',
    displayName: 'Downloads',
    maps: new Map(),
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

describe('TauriFileWriter', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('retries top-level directory roots with collision suffixes', async () => {
    apiMock.trzszCreateDownloadDirectory
      .mockRejectedValueOnce({ code: 'already_exists', message: 'exists' })
      .mockResolvedValue({ created: true });
    apiMock.trzszOpenSaveFile.mockResolvedValue({
      writerId: 'writer-1',
      localName: 'folder.0',
      displayName: 'child.txt',
      tempPath: '/tmp/file.part',
      finalPath: '/downloads/folder.0/child.txt',
    });

    const openSaveFile = createTauriOpenSaveFile('owner-1');
    const writer = await openSaveFile(
      createSaveRoot(),
      JSON.stringify({
        path_id: 7,
        path_name: ['folder', 'child.txt'],
        is_dir: false,
      }),
      true,
      false,
    );

    expect(apiMock.trzszCreateDownloadDirectory).toHaveBeenNthCalledWith(
      1,
      'owner-1',
      '/downloads',
      'folder',
      true,
    );
    expect(apiMock.trzszCreateDownloadDirectory).toHaveBeenNthCalledWith(
      2,
      'owner-1',
      '/downloads',
      'folder.0',
      true,
    );
    expect(apiMock.trzszOpenSaveFile).toHaveBeenCalledWith(
      'owner-1',
      '/downloads',
      'folder.0/child.txt',
      false,
      false,
    );
    expect(writer.getLocalName()).toBe('folder.0');
  });

  it('retries flat file downloads when the target name is blocked by an existing directory', async () => {
    apiMock.trzszOpenSaveFile
      .mockRejectedValueOnce({ code: 'invalid_path', message: 'Target path resolves to a directory: /downloads/file.txt' })
      .mockResolvedValueOnce({
        writerId: 'writer-flat',
        localName: 'file.txt.0',
        displayName: 'file.txt',
        tempPath: '/tmp/file.part',
        finalPath: '/downloads/file.txt.0',
      });

    const openSaveFile = createTauriOpenSaveFile('owner-1');
    const writer = await openSaveFile(createSaveRoot(), 'file.txt', false, false);

    expect(apiMock.trzszOpenSaveFile).toHaveBeenNthCalledWith(
      1,
      'owner-1',
      '/downloads',
      'file.txt',
      false,
      false,
    );
    expect(apiMock.trzszOpenSaveFile).toHaveBeenNthCalledWith(
      2,
      'owner-1',
      '/downloads',
      'file.txt.0',
      false,
      false,
    );
    expect(writer.getLocalName()).toBe('file.txt.0');
  });

  it('removes created directories when a directory writer is deleted', async () => {
    apiMock.trzszCreateDownloadDirectory.mockResolvedValue({ created: true });
    apiMock.trzszRemoveDownloadDirectory.mockResolvedValue(undefined);

    const openSaveFile = createTauriOpenSaveFile('owner-1');
    const writer = await openSaveFile(
      createSaveRoot(),
      JSON.stringify({
        path_id: 9,
        path_name: ['folder'],
        is_dir: true,
      }),
      true,
      false,
    );

    await writer.deleteFile();

    expect(apiMock.trzszRemoveDownloadDirectory).toHaveBeenCalledWith(
      'owner-1',
      '/downloads',
      'folder',
    );
  });

  it('deletes finished files and the directories created for them during rollback', async () => {
    apiMock.trzszCreateDownloadDirectory
      .mockResolvedValueOnce({ created: true })
      .mockResolvedValueOnce({ created: true });
    apiMock.trzszOpenSaveFile.mockResolvedValue({
      writerId: 'writer-2',
      localName: 'folder',
      displayName: 'child.txt',
      tempPath: '/tmp/file.part',
      finalPath: '/downloads/folder/nested/child.txt',
    });
    apiMock.trzszFinishDownloadFile.mockResolvedValue(undefined);
    apiMock.trzszRemoveDownloadFile.mockResolvedValue(undefined);
    apiMock.trzszRemoveDownloadDirectory.mockResolvedValue(undefined);

    const openSaveFile = createTauriOpenSaveFile('owner-1');
    const writer = await openSaveFile(
      createSaveRoot(),
      JSON.stringify({
        path_id: 10,
        path_name: ['folder', 'nested', 'child.txt'],
        is_dir: false,
      }),
      true,
      false,
    );

    await writer.finishFile?.();
    await writer.deleteFile();

    expect(apiMock.trzszRemoveDownloadFile).toHaveBeenCalledWith(
      'owner-1',
      '/downloads',
      'folder/nested/child.txt',
    );
    expect(apiMock.trzszRemoveDownloadDirectory).toHaveBeenNthCalledWith(
      1,
      'owner-1',
      '/downloads',
      'folder/nested',
    );
    expect(apiMock.trzszRemoveDownloadDirectory).toHaveBeenNthCalledWith(
      2,
      'owner-1',
      '/downloads',
      'folder',
    );
  });

  it('commits created directories after a successful write path', async () => {
    apiMock.trzszCreateDownloadDirectory.mockResolvedValue({ created: true });
    apiMock.trzszOpenSaveFile.mockResolvedValue({
      writerId: 'writer-5',
      localName: 'folder',
      displayName: 'child.txt',
      tempPath: '/tmp/file.part',
      finalPath: '/downloads/folder/child.txt',
    });
    apiMock.trzszCommitDownloadDirectory.mockResolvedValue(undefined);

    const openSaveFile = createTauriOpenSaveFile('owner-1');
    const writer = await openSaveFile(
      createSaveRoot(),
      JSON.stringify({
        path_id: 13,
        path_name: ['folder', 'child.txt'],
        is_dir: false,
      }),
      true,
      false,
    );

    await writer.commitFile?.();

    expect(apiMock.trzszCommitDownloadDirectory).toHaveBeenCalledWith(
      'owner-1',
      '/downloads',
      'folder',
    );
  });

  it('removes the final file if finish likely succeeded but the IPC reply failed', async () => {
    apiMock.trzszOpenSaveFile.mockResolvedValue({
      writerId: 'writer-6',
      localName: 'file.txt',
      displayName: 'file.txt',
      tempPath: '/tmp/file.part',
      finalPath: '/downloads/file.txt',
    });
    apiMock.trzszFinishDownloadFile.mockRejectedValue(new Error('{"code":"handle_not_found"}'));
    apiMock.trzszAbortDownloadFile.mockRejectedValue(new Error('{"code":"handle_not_found"}'));
    apiMock.trzszRemoveDownloadFile.mockResolvedValue(undefined);

    const openSaveFile = createTauriOpenSaveFile('owner-1');
    const writer = await openSaveFile(createSaveRoot(), 'file.txt', false, false);

    await expect(writer.finishFile?.()).rejects.toThrow();
    await writer.deleteFile();

    expect(apiMock.trzszRemoveDownloadFile).toHaveBeenCalledWith(
      'owner-1',
      '/downloads',
      'file.txt',
    );
  });

  it('rolls back precreated directories before retrying a file collision', async () => {
    apiMock.trzszCreateDownloadDirectory
      .mockResolvedValueOnce({ created: true })
      .mockResolvedValueOnce({ created: true })
      .mockResolvedValueOnce({ created: true })
      .mockResolvedValueOnce({ created: true });
    apiMock.trzszOpenSaveFile
      .mockRejectedValueOnce({ code: 'already_exists', message: 'exists' })
      .mockResolvedValueOnce({
        writerId: 'writer-4',
        localName: 'folder.0',
        displayName: 'child.txt',
        tempPath: '/tmp/file.part',
        finalPath: '/downloads/folder.0/nested/child.txt',
      });
    apiMock.trzszRemoveDownloadDirectory.mockResolvedValue(undefined);

    const openSaveFile = createTauriOpenSaveFile('owner-1');
    const writer = await openSaveFile(
      createSaveRoot(),
      JSON.stringify({
        path_id: 11,
        path_name: ['folder', 'nested', 'child.txt'],
        is_dir: false,
      }),
      true,
      false,
    );

    expect(apiMock.trzszRemoveDownloadDirectory).toHaveBeenNthCalledWith(
      1,
      'owner-1',
      '/downloads',
      'folder/nested',
    );
    expect(apiMock.trzszRemoveDownloadDirectory).toHaveBeenNthCalledWith(
      2,
      'owner-1',
      '/downloads',
      'folder',
    );
    expect(writer.getLocalName()).toBe('folder.0');
  });

  it('deletes every created parent directory for nested directory entries', async () => {
    apiMock.trzszCreateDownloadDirectory
      .mockResolvedValueOnce({ created: true })
      .mockResolvedValueOnce({ created: true })
      .mockResolvedValueOnce({ created: true });
    apiMock.trzszRemoveDownloadDirectory.mockResolvedValue(undefined);

    const openSaveFile = createTauriOpenSaveFile('owner-1');
    const writer = await openSaveFile(
      createSaveRoot(),
      JSON.stringify({
        path_id: 12,
        path_name: ['folder', 'nested', 'leaf'],
        is_dir: true,
      }),
      true,
      false,
    );

    await writer.deleteFile();

    expect(apiMock.trzszRemoveDownloadDirectory).toHaveBeenNthCalledWith(
      1,
      'owner-1',
      '/downloads',
      'folder/nested/leaf',
    );
    expect(apiMock.trzszRemoveDownloadDirectory).toHaveBeenNthCalledWith(
      2,
      'owner-1',
      '/downloads',
      'folder/nested',
    );
    expect(apiMock.trzszRemoveDownloadDirectory).toHaveBeenNthCalledWith(
      3,
      'owner-1',
      '/downloads',
      'folder',
    );
  });

  it('retries directory roots when the target name is blocked by an existing file', async () => {
    apiMock.trzszCreateDownloadDirectory
      .mockRejectedValueOnce({ code: 'invalid_path', message: 'Target path resolves to a file: /downloads/folder' })
      .mockResolvedValueOnce({ created: true });

    const openSaveFile = createTauriOpenSaveFile('owner-1');
    const writer = await openSaveFile(
      createSaveRoot(),
      JSON.stringify({
        path_id: 14,
        path_name: ['folder'],
        is_dir: true,
      }),
      true,
      false,
    );

    expect(apiMock.trzszCreateDownloadDirectory).toHaveBeenNthCalledWith(
      1,
      'owner-1',
      '/downloads',
      'folder',
      true,
    );
    expect(apiMock.trzszCreateDownloadDirectory).toHaveBeenNthCalledWith(
      2,
      'owner-1',
      '/downloads',
      'folder.0',
      true,
    );
    expect(writer.getLocalName()).toBe('folder.0');
  });

  it('rejects directory downloads when directory transfer is disabled', async () => {
    const openSaveFile = createTauriOpenSaveFile('owner-1', createPolicy({ allowDirectory: false }));

    await expect(
      openSaveFile(
        createSaveRoot(),
        JSON.stringify({
          path_id: 15,
          path_name: ['folder'],
          is_dir: true,
        }),
        true,
        false,
      ),
    ).rejects.toMatchObject({ code: 'directory_not_allowed' });
  });

  it('rejects downloads that exceed the configured file count limit', async () => {
    apiMock.trzszOpenSaveFile
      .mockResolvedValueOnce({
        writerId: 'writer-limit-1',
        localName: 'a.txt',
        displayName: 'a.txt',
        tempPath: '/tmp/a.part',
        finalPath: '/downloads/a.txt',
      });

    const openSaveFile = createTauriOpenSaveFile('owner-1', createPolicy({ maxFileCount: 1 }));
    await openSaveFile(createSaveRoot(), 'a.txt', false, false);

    await expect(openSaveFile(createSaveRoot(), 'b.txt', false, false)).rejects.toMatchObject({
      code: 'max_file_count_exceeded',
    });
  });

  it('rejects download chunks that exceed the configured total byte limit', async () => {
    apiMock.trzszOpenSaveFile.mockResolvedValue({
      writerId: 'writer-bytes-1',
      localName: 'file.txt',
      displayName: 'file.txt',
      tempPath: '/tmp/file.part',
      finalPath: '/downloads/file.txt',
    });

    const openSaveFile = createTauriOpenSaveFile('owner-1', createPolicy({ maxTotalBytes: 4 }));
    const writer = await openSaveFile(createSaveRoot(), 'file.txt', false, false);

    await expect(writer.writeFile?.(new Uint8Array([1, 2, 3, 4, 5]))).rejects.toMatchObject({
      code: 'max_total_bytes_exceeded',
    });
    expect(apiMock.trzszWriteDownloadChunk).not.toHaveBeenCalled();
  });
});