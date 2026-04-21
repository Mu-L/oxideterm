import { api } from '@/lib/api';
import type { TrzszFileReader } from '@/lib/terminal/trzsz/upstream/comm';
import {
  TrzszClientError,
  type TrzszTransferPolicy,
  type TrzszUploadEntryDto,
} from '@/lib/terminal/trzsz/types';

const DEFAULT_TRANSFER_POLICY: TrzszTransferPolicy = {
  allowDirectory: true,
  maxChunkBytes: 1024 * 1024,
  maxFileCount: Number.MAX_SAFE_INTEGER,
  maxTotalBytes: Number.MAX_SAFE_INTEGER,
};

export class TauriFileReader implements TrzszFileReader {
  private handleId: string | null = null;
  private offset = 0;
  private closed = false;

  constructor(
    private readonly ownerId: string,
    private readonly entry: TrzszUploadEntryDto,
  ) {}

  getPathId(): number {
    return this.entry.pathId;
  }

  getRelPath(): string[] {
    return [...this.entry.relPath];
  }

  isDir(): boolean {
    return this.entry.isDir;
  }

  getSize(): number {
    return this.entry.size;
  }

  async readFile(buffer: ArrayBuffer): Promise<Uint8Array> {
    if (this.closed || this.entry.isDir) {
      return new Uint8Array(0);
    }

    const handleId = await this.ensureHandle();
    const data = await api.trzszReadUploadChunk(this.ownerId, handleId, this.offset, buffer.byteLength);
    this.offset += data.byteLength;
    return data;
  }

  closeFile(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    const handleId = this.handleId;
    this.handleId = null;
    if (!handleId) {
      return;
    }

    void api.trzszCloseUploadFile(this.ownerId, handleId).catch(() => {
      // Best-effort cleanup on controller disposal or transfer failure.
    });
  }

  private async ensureHandle(): Promise<string> {
    if (this.handleId) {
      return this.handleId;
    }

    const handle = await api.trzszOpenUploadFile(this.ownerId, this.entry.path);
    this.handleId = handle.handleId;
    return handle.handleId;
  }
}

export async function buildTauriFileReaders(
  ownerId: string,
  paths: string[] | undefined,
  allowDirectory: boolean,
  policy: TrzszTransferPolicy = DEFAULT_TRANSFER_POLICY,
): Promise<TrzszFileReader[] | undefined> {
  if (!paths || paths.length === 0) {
    return undefined;
  }

  const entries = await api.trzszBuildUploadEntries(ownerId, paths, allowDirectory);
  if (entries.length === 0) {
    return undefined;
  }

  if (!policy.allowDirectory && entries.some((entry) => entry.isDir || entry.relPath.length > 1)) {
    throw new TrzszClientError(
      'directory_not_allowed',
      'Directory transfer is disabled by terminal settings.',
    );
  }

  const fileCount = entries.filter((entry) => !entry.isDir).length;
  if (fileCount > policy.maxFileCount) {
    throw new TrzszClientError(
      'max_file_count_exceeded',
      `Selected ${fileCount} files, which exceeds the current limit of ${policy.maxFileCount}.`,
      `selected=${fileCount}, max=${policy.maxFileCount}`,
    );
  }

  const totalBytes = entries.reduce((sum, entry) => sum + (entry.isDir ? 0 : entry.size), 0);
  if (totalBytes > policy.maxTotalBytes) {
    throw new TrzszClientError(
      'max_total_bytes_exceeded',
      `Selected ${totalBytes} bytes, which exceeds the current limit of ${policy.maxTotalBytes}.`,
      `selected=${totalBytes}, max=${policy.maxTotalBytes}`,
    );
  }

  return entries.map((entry) => new TauriFileReader(ownerId, entry));
}