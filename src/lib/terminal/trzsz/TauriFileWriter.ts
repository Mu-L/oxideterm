import { api } from '@/lib/api';
import { TrzszError } from '@/lib/terminal/trzsz/upstream/comm';
import type { OpenSaveFile, TrzszFileWriter } from '@/lib/terminal/trzsz/upstream/comm';
import {
  TrzszClientError,
  getTrzszErrorMessage,
  isTrzszErrorCode,
  parseTrzszDirectoryEntry,
  type TrzszDirectoryEntry,
  type TrzszSaveRoot,
  type TrzszTransferPolicy,
} from '@/lib/terminal/trzsz/types';

function joinRelPath(pathName: string[]): string {
  return pathName.join('/');
}

function nextCollisionName(baseName: string, attempt: number): string {
  if (attempt === 0) {
    return baseName;
  }

  return `${baseName}.${attempt - 1}`;
}

function isRetryableCollision(error: unknown): boolean {
  if (isTrzszErrorCode(error, 'already_exists')) {
    return true;
  }

  if (!isTrzszErrorCode(error, 'invalid_path')) {
    return false;
  }

  const message = getTrzszErrorMessage(error);
  return message.includes('resolves to a directory')
    || message.includes('resolves to a file')
    || message.includes('Target path is a directory');
}

class TauriDirectoryWriter implements TrzszFileWriter {
  constructor(
    private readonly ownerId: string,
    private readonly rootPath: string,
    private readonly cleanupDirectories: string[],
    private readonly fileName: string,
    private readonly localName: string,
  ) {}

  getFileName(): string {
    return this.fileName;
  }

  getLocalName(): string {
    return this.localName;
  }

  isDir(): boolean {
    return true;
  }

  async writeFile(): Promise<void> {
    throw new TrzszError(`Cannot write data into directory: ${this.fileName}`);
  }

  closeFile(): void {}

  async commitFile(): Promise<void> {
    for (const directoryPath of this.cleanupDirectories) {
      await api.trzszCommitDownloadDirectory(this.ownerId, this.rootPath, directoryPath);
    }
  }

  async finishFile(): Promise<void> {}

  async abortFile(): Promise<void> {
    for (let index = this.cleanupDirectories.length - 1; index >= 0; index -= 1) {
      await api.trzszRemoveDownloadDirectory(this.ownerId, this.rootPath, this.cleanupDirectories[index]);
    }
  }

  async deleteFile(): Promise<string> {
    await this.abortFile();
    return '';
  }
}

class TauriDownloadFileWriter implements TrzszFileWriter {
  private finished = false;
  private aborted = false;
  private finishStarted = false;

  constructor(
    private readonly ownerId: string,
    private readonly writerId: string,
    private readonly rootPath: string,
    private readonly relativePath: string,
    private readonly fileName: string,
    private readonly localName: string,
    private readonly cleanupDirectories: string[],
    private readonly constraintTracker: DownloadConstraintTracker,
  ) {}

  getFileName(): string {
    return this.fileName;
  }

  getLocalName(): string {
    return this.localName;
  }

  isDir(): boolean {
    return false;
  }

  async writeFile(buffer: Uint8Array): Promise<void> {
    if (this.finished || this.aborted) {
      throw new TrzszError(`Download writer is no longer active: ${this.fileName}`);
    }

    this.constraintTracker.consumeBytes(buffer.length);
    await api.trzszWriteDownloadChunk(this.ownerId, this.writerId, buffer);
  }

  closeFile(): void {}

  async commitFile(): Promise<void> {
    for (const directoryPath of this.cleanupDirectories) {
      await api.trzszCommitDownloadDirectory(this.ownerId, this.rootPath, directoryPath);
    }
  }

  async finishFile(): Promise<void> {
    if (this.finished || this.aborted) {
      return;
    }

    this.finishStarted = true;
    await api.trzszFinishDownloadFile(this.ownerId, this.writerId);
    this.finished = true;
  }

  async abortFile(): Promise<void> {
    if (this.finished || this.aborted) {
      return;
    }

    try {
      await api.trzszAbortDownloadFile(this.ownerId, this.writerId);
    } finally {
      this.aborted = true;
    }
  }

  async deleteFile(): Promise<string> {
    if (this.finished) {
      await api.trzszRemoveDownloadFile(this.ownerId, this.rootPath, this.relativePath);
    } else {
      try {
        await this.abortFile();
      } catch (error) {
        if (this.finishStarted && isTrzszErrorCode(error, 'handle_not_found')) {
          await api.trzszRemoveDownloadFile(this.ownerId, this.rootPath, this.relativePath);
        } else {
          throw error;
        }
      }
    }

    for (let index = this.cleanupDirectories.length - 1; index >= 0; index -= 1) {
      await api.trzszRemoveDownloadDirectory(this.ownerId, this.rootPath, this.cleanupDirectories[index]);
    }
    return '';
  }
}

class DownloadConstraintTracker {
  private fileCount = 0;
  private totalBytes = 0;

  constructor(private readonly policy: TrzszTransferPolicy) {}

  ensureDirectoryAllowed(): void {
    if (!this.policy.allowDirectory) {
      throw new TrzszClientError(
        'directory_not_allowed',
        'Directory transfer is disabled by terminal settings.',
      );
    }
  }

  assertCanAddFile(): void {
    if (this.fileCount + 1 > this.policy.maxFileCount) {
      throw new TrzszClientError(
        'max_file_count_exceeded',
        `Transfer exceeds the current file limit of ${this.policy.maxFileCount}.`,
        `selected=${this.fileCount + 1}, max=${this.policy.maxFileCount}`,
      );
    }
  }

  commitFile(): void {
    this.fileCount += 1;
  }

  consumeBytes(bytes: number): void {
    const nextTotal = this.totalBytes + bytes;
    if (nextTotal > this.policy.maxTotalBytes) {
      throw new TrzszClientError(
        'max_total_bytes_exceeded',
        `Transfer exceeds the current total size limit of ${this.policy.maxTotalBytes} bytes.`,
        `received=${nextTotal}, max=${this.policy.maxTotalBytes}`,
      );
    }

    this.totalBytes = nextTotal;
  }
}

async function ensureDownloadDirectory(
  ownerId: string,
  rootPath: string,
  directoryPath: string,
  cleanupDirectories: string[],
  mustCreate = false,
): Promise<void> {
  const dto = await api.trzszCreateDownloadDirectory(ownerId, rootPath, directoryPath, mustCreate);
  if (dto.created) {
    cleanupDirectories.push(directoryPath);
  }
}

async function openFlatSaveFile(
  ownerId: string,
  saveRoot: TrzszSaveRoot,
  fileName: string,
  overwrite: boolean,
  constraintTracker: DownloadConstraintTracker,
): Promise<TrzszFileWriter> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const candidateName = overwrite ? fileName : nextCollisionName(fileName, attempt);

    try {
      constraintTracker.assertCanAddFile();
      const dto = await api.trzszOpenSaveFile(ownerId, saveRoot.rootPath, candidateName, false, overwrite);
      constraintTracker.commitFile();
      return new TauriDownloadFileWriter(
        ownerId,
        dto.writerId,
        saveRoot.rootPath,
        candidateName,
        fileName,
        dto.localName,
        [],
        constraintTracker,
      );
    } catch (error) {
      lastError = error;
      if (!overwrite && isRetryableCollision(error)) {
        continue;
      }
      throw error;
    }
  }

  throw new TrzszError(getTrzszErrorMessage(lastError));
}

async function openDirectorySaveEntry(
  ownerId: string,
  saveRoot: TrzszSaveRoot,
  entry: TrzszDirectoryEntry,
  overwrite: boolean,
  constraintTracker: DownloadConstraintTracker,
): Promise<TrzszFileWriter> {
  const existingLocalName = overwrite ? entry.pathName[0] : saveRoot.maps.get(entry.pathId);
  const restPath = entry.pathName.slice(1);

  const tryOpenWithRoot = async (localRoot: string, claimTopLevel: boolean): Promise<TrzszFileWriter> => {
    const cleanupDirectories: string[] = [];
    try {
      if (entry.isDir || restPath.length > 0) {
        constraintTracker.ensureDirectoryAllowed();
      }

      if (claimTopLevel && (entry.isDir || restPath.length > 0)) {
        await ensureDownloadDirectory(ownerId, saveRoot.rootPath, localRoot, cleanupDirectories, !overwrite);
      }

      const relativePath = joinRelPath([localRoot, ...restPath]);

      if (entry.isDir) {
        for (let index = 0; index < restPath.length; index += 1) {
          const directoryPath = joinRelPath([localRoot, ...restPath.slice(0, index + 1)]);
          await ensureDownloadDirectory(ownerId, saveRoot.rootPath, directoryPath, cleanupDirectories);
        }
        return new TauriDirectoryWriter(
          ownerId,
          saveRoot.rootPath,
          cleanupDirectories,
          entry.pathName[entry.pathName.length - 1],
          localRoot,
        );
      }

      constraintTracker.assertCanAddFile();

      for (let index = 0; index < restPath.length - 1; index += 1) {
        const directoryPath = joinRelPath([localRoot, ...restPath.slice(0, index + 1)]);
        await ensureDownloadDirectory(ownerId, saveRoot.rootPath, directoryPath, cleanupDirectories);
      }

      const dto = await api.trzszOpenSaveFile(ownerId, saveRoot.rootPath, relativePath, false, overwrite);
      constraintTracker.commitFile();
      return new TauriDownloadFileWriter(
        ownerId,
        dto.writerId,
        saveRoot.rootPath,
        relativePath,
        entry.pathName[entry.pathName.length - 1],
        localRoot,
        cleanupDirectories,
        constraintTracker,
      );
    } catch (error) {
      for (let index = cleanupDirectories.length - 1; index >= 0; index -= 1) {
        try {
          await api.trzszRemoveDownloadDirectory(ownerId, saveRoot.rootPath, cleanupDirectories[index]);
        } catch {
          // Prefer surfacing the original open error.
        }
      }
      throw error;
    }
  };

  if (existingLocalName) {
    return tryOpenWithRoot(existingLocalName, false);
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const localRoot = overwrite ? entry.pathName[0] : nextCollisionName(entry.pathName[0], attempt);
    try {
      const writer = await tryOpenWithRoot(localRoot, true);
      saveRoot.maps.set(entry.pathId, localRoot);
      return writer;
    } catch (error) {
      lastError = error;
      if (!overwrite && isRetryableCollision(error)) {
        continue;
      }
      throw error;
    }
  }

  throw new TrzszError(getTrzszErrorMessage(lastError));
}

export function createTauriOpenSaveFile(
  ownerId: string,
  policy: TrzszTransferPolicy = {
    allowDirectory: true,
    maxChunkBytes: 1024 * 1024,
    maxFileCount: 1024,
    maxTotalBytes: 10 * 1024 * 1024 * 1024,
  },
): OpenSaveFile {
  const constraintTracker = new DownloadConstraintTracker(policy);
  return async (saveParam, fileName, directory, overwrite) => {
    const saveRoot = saveParam as TrzszSaveRoot;
    if (!directory) {
      return openFlatSaveFile(ownerId, saveRoot, fileName, overwrite, constraintTracker);
    }

    return openDirectorySaveEntry(
      ownerId,
      saveRoot,
      parseTrzszDirectoryEntry(fileName),
      overwrite,
      constraintTracker,
    );
  };
}