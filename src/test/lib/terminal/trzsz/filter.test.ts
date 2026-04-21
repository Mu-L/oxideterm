import { afterEach, describe, expect, it, vi } from 'vitest';

import { TrzszFilter } from '@/lib/terminal/trzsz/upstream/filter';

function createTransferPolicy() {
  return {
    allowDirectory: true,
    maxChunkBytes: 1024,
    maxFileCount: 32,
    maxTotalBytes: 4096,
  };
}

function createFilter(overrides: Partial<ConstructorParameters<typeof TrzszFilter>[0]> = {}) {
  const sendToServer = vi.fn();
  const writeToTerminal = vi.fn();
  const buildFileReaders = vi.fn(async () => undefined);
  const getTransferPolicy = vi.fn(() => createTransferPolicy());

  const filter = new TrzszFilter({
    writeToTerminal,
    sendToServer,
    chooseSendFiles: vi.fn(async () => undefined),
    buildFileReaders,
    chooseSaveDirectory: vi.fn(async () => undefined),
    createOpenSaveFile: vi.fn(() => vi.fn()),
    getTransferPolicy,
    terminalColumns: 80,
    isWindowsShell: false,
    dragInitTimeout: 25,
    ...overrides,
  });

  return {
    filter,
    sendToServer,
    writeToTerminal,
    buildFileReaders,
    getTransferPolicy,
  };
}

describe('TrzszFilter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps normal terminal IO working after stopTransferringFiles without an active transfer', () => {
    const { filter, sendToServer } = createFilter();

    filter.stopTransferringFiles();
    filter.processTerminalInput('echo ready');
    filter.processBinaryInput('\u001bOA');

    expect(sendToServer).toHaveBeenNthCalledWith(1, 'echo ready');
    expect(sendToServer).toHaveBeenNthCalledWith(2, new Uint8Array([0x1b, 0x4f, 0x41]));
  });

  it('intercepts terminal input while a transfer is active and cancels on Ctrl+C', () => {
    const { filter, sendToServer } = createFilter();
    const stopTransferring = vi.fn();

    (filter as unknown as { trzszTransfer: { stopTransferring: () => void } }).trzszTransfer = {
      stopTransferring,
    };

    filter.processTerminalInput('pwd');
    filter.processBinaryInput('\u001bOA');
    filter.processTerminalInput('\x03');

    expect(sendToServer).not.toHaveBeenCalled();
    expect(stopTransferring).toHaveBeenCalledTimes(1);
  });

  it('snapshots the latest policy for uploads and rejects when the handshake times out', async () => {
    vi.useFakeTimers();

    const policy = {
      allowDirectory: false,
      maxChunkBytes: 2048,
      maxFileCount: 5,
      maxTotalBytes: 8192,
    };
    const fileReader = {
      getPathId: () => 1,
      getRelPath: () => ['demo.txt'],
      isDir: () => false,
      getSize: () => 4,
      readFile: vi.fn(async () => new Uint8Array([1, 2, 3, 4])),
      closeFile: vi.fn(),
    };
    const buildFileReaders = vi.fn(async () => [fileReader]);
    const getTransferPolicy = vi.fn(() => policy);
    const { filter, sendToServer } = createFilter({
      buildFileReaders,
      getTransferPolicy,
      dragInitTimeout: 25,
    });

    const uploadResult = filter.uploadFiles(['/tmp/demo.txt']).catch((error) => error);

    await vi.advanceTimersByTimeAsync(200);
    expect(buildFileReaders).toHaveBeenCalledWith(['/tmp/demo.txt'], true, policy);
    expect(getTransferPolicy).toHaveBeenCalledTimes(1);
    expect(sendToServer).toHaveBeenNthCalledWith(1, '\x03');
    expect(sendToServer).toHaveBeenNthCalledWith(2, 'trz\r');

    await vi.advanceTimersByTimeAsync(25);
    await expect(uploadResult).resolves.toBe('Upload does not start');
  });
});