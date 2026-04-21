import { afterEach, describe, expect, it, vi } from 'vitest';

const transferConstructorArgs = vi.hoisted(() => [] as number[]);

vi.mock('@/lib/terminal/trzsz/upstream/transfer', () => ({
  TrzszTransfer: class {
    constructor(
      _writer: (data: string | Uint8Array) => void,
      _isWindowsShell: boolean,
      maxChunkBytes: number,
    ) {
      transferConstructorArgs.push(maxChunkBytes);
    }

    addReceivedData() {}

    setRemotePlatform() {}

    async stopTransferring() {}

    async sendAction() {}

    async recvConfig() {
      return { quiet: true, directory: false };
    }

    async recvFiles() {
      return [];
    }

    async clientExit() {}

    async clientError() {}

    async cleanup() {}
  },
}));

import { TrzszFilter } from '@/lib/terminal/trzsz/upstream/filter';

describe('TrzszFilter transfer policy', () => {
  afterEach(() => {
    transferConstructorArgs.length = 0;
  });

  it('passes the configured max chunk size into each new transfer handshake', async () => {
    const filter = new TrzszFilter({
      writeToTerminal: vi.fn(),
      sendToServer: vi.fn(),
      chooseSendFiles: vi.fn(async () => undefined),
      buildFileReaders: vi.fn(async () => undefined),
      chooseSaveDirectory: vi.fn(async () => undefined),
      createOpenSaveFile: vi.fn(() => vi.fn()),
      getTransferPolicy: vi.fn(() => ({
        allowDirectory: true,
        maxChunkBytes: 32 * 1024,
        maxFileCount: 16,
        maxTotalBytes: 1024 * 1024,
      })),
      terminalColumns: 80,
      isWindowsShell: false,
    });

    await (filter as unknown as {
      detectAndHandleTrzsz: (output: string) => Promise<void>;
    }).detectAndHandleTrzsz('::TRZSZ:TRANSFER:S:1.1.6:12345678\r\n');

    expect(transferConstructorArgs).toEqual([32 * 1024]);
  });
});