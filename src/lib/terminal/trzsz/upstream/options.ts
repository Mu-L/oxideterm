import type {
  TrzszSaveRoot,
  TrzszTransferEvent,
  TrzszTransferPolicy,
} from '@/lib/terminal/trzsz/types';
import type { OpenSaveFile, TrzszFileReader } from '@/lib/terminal/trzsz/upstream/comm';

export type TrzszOptions = {
  writeToTerminal?: (output: string | ArrayBuffer | Uint8Array | Blob) => void;
  sendToServer?: (input: string | Uint8Array) => void;
  chooseSendFiles?: (directory?: boolean) => Promise<string[] | undefined>;
  buildFileReaders?: (
    paths: string[],
    directory: boolean,
    policy: TrzszTransferPolicy,
  ) => Promise<TrzszFileReader[] | undefined>;
  chooseSaveDirectory?: () => Promise<TrzszSaveRoot | undefined>;
  createOpenSaveFile?: (policy: TrzszTransferPolicy) => OpenSaveFile;
  getTransferPolicy?: () => TrzszTransferPolicy;
  onTransferEvent?: (event: TrzszTransferEvent) => void;
  terminalColumns?: number;
  isWindowsShell?: boolean;
  dragInitTimeout?: number | null;
};