import { Md5 } from 'ts-md5';

import { TrzszBuffer } from '@/lib/terminal/trzsz/upstream/buffer';
import {
  decodeBuffer,
  encodeBuffer,
  OpenSaveFile,
  ProgressCallback,
  stripTmuxStatusLine,
  TrzszError,
  TrzszFile,
  TrzszFileReader,
  TrzszFileWriter,
  trzszVersion,
  uint8ToStr,
} from '@/lib/terminal/trzsz/upstream/comm';
import { escapeCharsToCodes, escapeData, unescapeData } from '@/lib/terminal/trzsz/upstream/escape';

export class TrzszTransfer {
  private static readonly MAX_DATA_CHUNK_SIZE = 10 * 1024 * 1024;

  private readonly buffer = new TrzszBuffer();
  private readonly openedFiles: TrzszFile[] = [];
  private readonly createdFiles: TrzszFileWriter[] = [];
  private rollbackCreatedFiles = false;
  private remoteIsWindows = false;
  private lastInputTime = 0;
  private tmuxOutputJunk = false;
  private cleanTimeoutInMilliseconds = 100;
  private transferConfig: Record<string, unknown> = {};
  private stopped = false;
  private maxChunkTimeInMilliseconds = 0;
  private protocolNewline = '\n';

  constructor(
    private readonly writer: (data: string | Uint8Array) => void,
    private readonly isWindowsShell = false,
    private readonly maxDataChunkSize = TrzszTransfer.MAX_DATA_CHUNK_SIZE,
  ) {}

  async cleanup(): Promise<void> {
    for (const file of this.openedFiles) {
      file.closeFile();
    }

    if (this.rollbackCreatedFiles) {
      for (let index = this.createdFiles.length - 1; index >= 0; index -= 1) {
        try {
          await this.createdFiles[index].deleteFile();
        } catch {
          // Cleanup is best-effort once the transfer has already failed or stopped.
        }
      }
    }

    this.openedFiles.length = 0;
    this.createdFiles.length = 0;
    this.rollbackCreatedFiles = false;
  }

  addReceivedData(data: string | ArrayBuffer | Uint8Array | Blob): void {
    if (!this.stopped) {
      this.buffer.addBuffer(data);
    }
    this.lastInputTime = Date.now();
  }

  async stopTransferring(): Promise<void> {
    this.cleanTimeoutInMilliseconds = Math.max(this.maxChunkTimeInMilliseconds * 2, 500);
    this.stopped = true;
    this.buffer.stopBuffer();
  }

  setRemotePlatform(remoteIsWindows: boolean): void {
    if (!remoteIsWindows) {
      return;
    }

    this.remoteIsWindows = true;
    this.protocolNewline = '!\n';
  }

  async sendAction(confirm: boolean, remoteIsWindows: boolean): Promise<void> {
    const action: Record<string, unknown> = {
      lang: 'js',
      confirm,
      version: trzszVersion,
      support_dir: true,
    };

    if (this.isWindowsShell || remoteIsWindows) {
      action.binary = false;
      action.newline = '!\n';
    }

    if (remoteIsWindows) {
      this.remoteIsWindows = true;
      this.protocolNewline = '!\n';
    }

    await this.sendString('ACT', JSON.stringify(action));
  }

  async recvConfig(): Promise<Record<string, unknown>> {
    const buffer = await this.recvString('CFG', true);
    this.transferConfig = JSON.parse(buffer) as Record<string, unknown>;
    this.tmuxOutputJunk = this.transferConfig.tmux_output_junk === true;
    return this.transferConfig;
  }

  async clientExit(message: string): Promise<void> {
    await this.sendString('EXIT', message);
  }

  async clientError(error: Error): Promise<void> {
    await this.cleanInput(this.cleanTimeoutInMilliseconds);

    const message = TrzszError.getErrorMessage(error);
    let trace = true;
    if (error instanceof TrzszError) {
      trace = error.isTraceBack();
      if (error.isRemoteExit()) {
        return;
      }
      if (error.isRemoteFail()) {
        if (trace) {
          console.log(message);
        }
        return;
      }
    }

    await this.sendString(trace ? 'FAIL' : 'fail', message);
    if (trace) {
      console.log(message);
    }
  }

  async sendFiles(files: TrzszFileReader[], progressCallback: ProgressCallback | null): Promise<string[]> {
    this.openedFiles.push(...files);

    const binary = this.transferConfig.binary === true;
    const directory = this.transferConfig.directory === true;
    const configuredBufSize = typeof this.transferConfig.bufsize === 'number' ? this.transferConfig.bufsize : null;
    const maxBufferSize = configuredBufSize
      ? Math.min(configuredBufSize, this.maxDataChunkSize)
      : this.maxDataChunkSize;
    const escapeCodes = Array.isArray(this.transferConfig.escape_chars)
      ? escapeCharsToCodes(this.transferConfig.escape_chars as string[][])
      : [];

    await this.sendFileNum(files.length, progressCallback);

    const remoteNames: string[] = [];
    for (const file of files) {
      const remoteName = await this.sendFileName(file, directory, progressCallback);
      if (!remoteNames.includes(remoteName)) {
        remoteNames.push(remoteName);
      }

      if (file.isDir()) {
        continue;
      }

      const size = file.getSize();
      await this.sendFileSize(size, progressCallback);
      const digest = await this.sendFileData(file, size, binary, escapeCodes, maxBufferSize, progressCallback);
      file.closeFile();
      await this.sendFileMD5(digest, progressCallback);
    }

    return remoteNames;
  }

  async recvFiles(
    saveParam: unknown,
    openSaveFile: OpenSaveFile,
    progressCallback: ProgressCallback | null,
  ): Promise<string[]> {
    const binary = this.transferConfig.binary === true;
    const directory = this.transferConfig.directory === true;
    // Local overwrite policy stays under OxideTerm control; remote CFG.overwrite is advisory only.
    const overwrite = false;
    const timeoutInMilliseconds = typeof this.transferConfig.timeout === 'number'
      ? this.transferConfig.timeout * 1000
      : 100000;
    const escapeCodes = Array.isArray(this.transferConfig.escape_chars)
      ? escapeCharsToCodes(this.transferConfig.escape_chars as string[][])
      : [];

    this.rollbackCreatedFiles = true;
    const num = await this.recvFileNum(progressCallback);
    const localNames: string[] = [];
    for (let index = 0; index < num; index += 1) {
      const file = await this.recvFileName(saveParam, openSaveFile, directory, overwrite, progressCallback);
      if (!localNames.includes(file.getLocalName())) {
        localNames.push(file.getLocalName());
      }

      if (file.isDir()) {
        continue;
      }

      this.openedFiles.push(file);
      try {
        const size = await this.recvFileSize(progressCallback);
        const digest = await this.recvFileData(
          file,
          size,
          binary,
          escapeCodes,
          timeoutInMilliseconds,
          progressCallback,
        );
        file.closeFile();
        await this.recvFileMD5(digest, progressCallback);
        if (file.finishFile) {
          await file.finishFile();
        }
      } catch (error) {
        try {
          if (file.abortFile) {
            await file.abortFile();
          }
        } catch {
          // Prefer surfacing the original transfer error.
        }
        throw error;
      }
    }

    for (const file of this.createdFiles) {
      if (file.commitFile) {
        await file.commitFile();
      }
    }

    this.rollbackCreatedFiles = false;
    return localNames;
  }

  private async cleanInput(timeoutInMilliseconds: number): Promise<void> {
    this.stopped = true;
    this.buffer.drainBuffer();
    this.lastInputTime = Date.now();
    while (true) {
      const sleepTime = timeoutInMilliseconds - (Date.now() - this.lastInputTime);
      if (sleepTime <= 0) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, sleepTime));
    }
  }

  private async sendLine(type: string, buffer: string): Promise<void> {
    this.writer(`#${type}:${buffer}${this.protocolNewline}`);
  }

  private async recvLine(expectType: string, mayHaveJunk = false): Promise<string> {
    if (this.stopped) {
      throw new TrzszError('Stopped');
    }

    if (this.isWindowsShell || this.remoteIsWindows) {
      let line = await this.buffer.readLineOnWindows();
      const index = line.lastIndexOf(`#${expectType}:`);
      if (index >= 0) {
        return line.substring(index);
      }
      const fallbackIndex = line.lastIndexOf('#');
      return fallbackIndex > 0 ? line.substring(fallbackIndex) : line;
    }

    let line = await this.buffer.readLine();
    if (this.tmuxOutputJunk || mayHaveJunk) {
      while (line.endsWith('\r')) {
        line = line.substring(0, line.length - 1) + (await this.buffer.readLine());
      }

      const index = line.lastIndexOf(`#${expectType}:`);
      if (index >= 0) {
        line = line.substring(index);
      } else {
        const fallbackIndex = line.lastIndexOf('#');
        if (fallbackIndex > 0) {
          line = line.substring(fallbackIndex);
        }
      }

      line = stripTmuxStatusLine(line);
    }

    return line;
  }

  private async recvCheck(expectType: string, mayHaveJunk = false): Promise<string> {
    const line = await this.recvLine(expectType, mayHaveJunk);
    const separatorIndex = line.indexOf(':');
    if (separatorIndex < 1) {
      throw new TrzszError(encodeBuffer(line), 'colon', true);
    }

    const type = line.substring(1, separatorIndex);
    const buffer = line.substring(separatorIndex + 1);
    if (type !== expectType) {
      throw new TrzszError(buffer, type, true);
    }
    return buffer;
  }

  private async sendInteger(type: string, value: number): Promise<void> {
    await this.sendLine(type, value.toString());
  }

  private async recvInteger(type: string, mayHaveJunk = false): Promise<number> {
    return Number(await this.recvCheck(type, mayHaveJunk));
  }

  private async checkInteger(expect: number): Promise<void> {
    const result = await this.recvInteger('SUCC');
    if (result !== expect) {
      throw new TrzszError(`Integer check [${result}] <> [${expect}]`, null, true);
    }
  }

  private async sendString(type: string, value: string): Promise<void> {
    await this.sendLine(type, encodeBuffer(value));
  }

  private async recvString(type: string, mayHaveJunk = false): Promise<string> {
    return uint8ToStr(decodeBuffer(await this.recvCheck(type, mayHaveJunk)), 'utf8');
  }

  private async checkBinary(expect: Uint8Array): Promise<void> {
    const result = await this.recvBinary('SUCC');
    if (result.length !== expect.length) {
      throw new TrzszError(`Binary length check [${result.length}] <> [${expect.length}]`, null, true);
    }

    for (let index = 0; index < result.length; index += 1) {
      if (result[index] !== expect[index]) {
        throw new TrzszError(`Binary check [${result[index]}] <> [${expect[index]}]`, null, true);
      }
    }
  }

  private async sendBinary(type: string, buffer: Uint8Array): Promise<void> {
    await this.sendLine(type, encodeBuffer(buffer));
  }

  private async recvBinary(type: string, mayHaveJunk = false): Promise<Uint8Array> {
    return decodeBuffer(await this.recvCheck(type, mayHaveJunk));
  }

  private async sendData(data: Uint8Array, binary: boolean, escapeCodes: number[][]): Promise<void> {
    if (!binary) {
      await this.sendBinary('DATA', data);
      return;
    }

    const escaped = escapeData(data, escapeCodes);
    this.writer(`#DATA:${escaped.length}\n`);
    this.writer(escaped);
  }

  private async recvData(
    binary: boolean,
    escapeCodes: number[][],
    timeoutInMilliseconds: number,
  ): Promise<Uint8Array> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race<Uint8Array>([
        new Promise<Uint8Array>((_, reject) => {
          timeoutId = setTimeout(() => {
            this.cleanTimeoutInMilliseconds = 3000;
            reject(new TrzszError('Receive data timeout'));
          }, timeoutInMilliseconds);
        }),
        (async () => {
          if (!binary) {
            return this.recvBinary('DATA');
          }

          const size = await this.recvInteger('DATA');
          return unescapeData(await this.buffer.readBinary(size), escapeCodes);
        })(),
      ]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  private async sendFileNum(num: number, progressCallback: ProgressCallback | null): Promise<void> {
    await this.sendInteger('NUM', num);
    await this.checkInteger(num);
    progressCallback?.onNum(num);
  }

  private async sendFileName(
    file: TrzszFileReader,
    directory: boolean,
    progressCallback: ProgressCallback | null,
  ): Promise<string> {
    const relPath = file.getRelPath();
    const fileName = relPath[relPath.length - 1];
    if (directory) {
      await this.sendString('NAME', JSON.stringify({
        path_id: file.getPathId(),
        path_name: relPath,
        is_dir: file.isDir(),
      }));
    } else {
      await this.sendString('NAME', fileName);
    }

    const remoteName = await this.recvString('SUCC');
    progressCallback?.onName(fileName);
    return remoteName;
  }

  private async sendFileSize(size: number, progressCallback: ProgressCallback | null): Promise<void> {
    await this.sendInteger('SIZE', size);
    await this.checkInteger(size);
    progressCallback?.onSize(size);
  }

  private async sendFileData(
    file: TrzszFileReader,
    size: number,
    binary: boolean,
    escapeCodes: number[][],
    maxBufferSize: number,
    progressCallback: ProgressCallback | null,
  ): Promise<Uint8Array> {
    let step = 0;
    progressCallback?.onStep(step);
    let bufferSize = 1024;
    let buffer = new ArrayBuffer(bufferSize);
    const md5 = new Md5();
    while (step < size) {
      const beginTime = Date.now();
      const data = await file.readFile(buffer);
      if (data.length === 0) {
        throw new TrzszError(`Unexpected EOF while reading ${file.getRelPath().join('/')}`);
      }
      await this.sendData(data, binary, escapeCodes);
      md5.appendByteArray(data);
      await this.checkInteger(data.length);
      step += data.length;
      progressCallback?.onStep(step);

      const chunkTime = Date.now() - beginTime;
      if (data.length === bufferSize && chunkTime < 500 && bufferSize < maxBufferSize) {
        bufferSize = Math.min(bufferSize * 2, maxBufferSize);
        buffer = new ArrayBuffer(bufferSize);
      } else if (chunkTime >= 2000 && bufferSize > 1024) {
        bufferSize = 1024;
        buffer = new ArrayBuffer(bufferSize);
      }

      if (chunkTime > this.maxChunkTimeInMilliseconds) {
        this.maxChunkTimeInMilliseconds = chunkTime;
      }
    }

    return new Uint8Array((md5.end(true) as Int32Array).buffer);
  }

  private async sendFileMD5(digest: Uint8Array, progressCallback: ProgressCallback | null): Promise<void> {
    await this.sendBinary('MD5', digest);
    await this.checkBinary(digest);
    progressCallback?.onDone();
  }

  private async recvFileNum(progressCallback: ProgressCallback | null): Promise<number> {
    const num = await this.recvInteger('NUM');
    await this.sendInteger('SUCC', num);
    progressCallback?.onNum(num);
    return num;
  }

  private async recvFileName(
    saveParam: unknown,
    openSaveFile: OpenSaveFile,
    directory: boolean,
    overwrite: boolean,
    progressCallback: ProgressCallback | null,
  ): Promise<TrzszFileWriter> {
    const fileName = await this.recvString('NAME');
    const file = await openSaveFile(saveParam, fileName, directory, overwrite);
    this.createdFiles.push(file);
    await this.sendString('SUCC', file.getLocalName());
    progressCallback?.onName(file.getFileName());
    return file;
  }

  private async recvFileSize(progressCallback: ProgressCallback | null): Promise<number> {
    const size = await this.recvInteger('SIZE');
    await this.sendInteger('SUCC', size);
    progressCallback?.onSize(size);
    return size;
  }

  private async recvFileData(
    file: TrzszFileWriter,
    size: number,
    binary: boolean,
    escapeCodes: number[][],
    timeoutInMilliseconds: number,
    progressCallback: ProgressCallback | null,
  ): Promise<Uint8Array> {
    let step = 0;
    progressCallback?.onStep(step);
    const md5 = new Md5();
    while (step < size) {
      const beginTime = Date.now();
      const data = await this.recvData(binary, escapeCodes, timeoutInMilliseconds);
      await file.writeFile(data);
      step += data.length;
      progressCallback?.onStep(step);
      await this.sendInteger('SUCC', data.length);
      md5.appendByteArray(data);

      const chunkTime = Date.now() - beginTime;
      if (chunkTime > this.maxChunkTimeInMilliseconds) {
        this.maxChunkTimeInMilliseconds = chunkTime;
      }
    }

    return new Uint8Array((md5.end(true) as Int32Array).buffer);
  }

  private async recvFileMD5(digest: Uint8Array, progressCallback: ProgressCallback | null): Promise<void> {
    const expectedDigest = await this.recvBinary('MD5');
    if (digest.length !== expectedDigest.length) {
      throw new TrzszError('Check MD5 failed');
    }

    for (let index = 0; index < digest.length; index += 1) {
      if (digest[index] !== expectedDigest[index]) {
        throw new TrzszError('Check MD5 failed');
      }
    }

    await this.sendBinary('SUCC', digest);
    progressCallback?.onDone();
  }
}