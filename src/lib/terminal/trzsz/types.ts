export const TRZSZ_API_VERSION = 1;

export type TrzszUploadEntryDto = {
  pathId: number;
  path: string;
  relPath: string[];
  size: number;
  isDir: boolean;
  isSymlink: boolean;
};

export type TrzszUploadHandleDto = {
  handleId: string;
  size: number;
};

export type TrzszPreparedDownloadRootDto = {
  rootPath: string;
};

export type TrzszCreateDownloadDirectoryDto = {
  created: boolean;
};

export type TrzszDownloadOpenDto = {
  writerId: string;
  localName: string;
  displayName: string;
  tempPath: string;
  finalPath: string;
};

export type TrzszOwnerCleanupDto = {
  ownerId: string;
  uploadHandles: number;
  downloadHandles: number;
};

export type TrzszSaveRoot = {
  rootPath: string;
  displayName: string;
  maps: Map<number, string>;
};

export type TrzszDirectoryEntry = {
  pathId: number;
  pathName: string[];
  isDir: boolean;
};

export type TrzszTransferDirection = 'upload' | 'download';

export type TrzszTransferSelection = 'file' | 'directory';

export type TrzszTransferPolicy = {
  allowDirectory: boolean;
  maxChunkBytes: number;
  maxFileCount: number;
  maxTotalBytes: number;
};

export type TrzszTransferEvent =
  | {
      type: 'prompt';
      direction: TrzszTransferDirection;
      selection: TrzszTransferSelection;
    }
  | {
      type: 'cancelled';
      direction: TrzszTransferDirection;
      selection: TrzszTransferSelection;
    }
  | {
      type: 'completed';
      direction: TrzszTransferDirection;
      selection: TrzszTransferSelection;
    }
  | {
      type: 'failed';
      direction: TrzszTransferDirection;
      selection: TrzszTransferSelection;
      error: unknown;
    }
  | {
      type: 'connection_lost';
    }
  | {
      type: 'partial_cleanup';
    };

export type TrzszInvokeError = {
  code?: string;
  message?: string;
  detail?: string | null;
};

export class TrzszClientError extends Error {
  readonly code: string;
  readonly detail: string | null;

  constructor(code: string, message: string, detail?: string | null) {
    super(message);
    Object.setPrototypeOf(this, TrzszClientError.prototype);
    this.name = 'TrzszClientError';
    this.code = code;
    this.detail = detail ?? null;
  }
}

export function normalizeTrzszDialogSelection(
  selection: string | string[] | null | undefined,
): string[] | undefined {
  if (!selection) {
    return undefined;
  }

  if (typeof selection === 'string') {
    return selection.length > 0 ? [selection] : undefined;
  }

  return selection.length > 0 ? selection : undefined;
}

export function getTrzszErrorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as TrzszInvokeError).code;
    return typeof code === 'string' && code.length > 0 ? code : undefined;
  }

  const message = error instanceof Error ? error.message : String(error);
  const directMatch = message.match(/invalid_[a-z_]+|already_exists|root_[a-z_]+|symlink_[a-z_]+|handle_[a-z_]+/i);
  if (directMatch) {
    return directMatch[0].toLowerCase();
  }

  const jsonMatch = message.match(/"code"\s*:\s*"([a-z_]+)"/i);
  if (jsonMatch) {
    return jsonMatch[1].toLowerCase();
  }

  return undefined;
}

export function isTrzszErrorCode(error: unknown, code: string): boolean {
  return getTrzszErrorCode(error) === code;
}

export function getTrzszErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as TrzszInvokeError).message;
    if (typeof message === 'string' && message.length > 0) {
      return message;
    }
  }

  return String(error);
}

export function getTrzszErrorDetail(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'detail' in error) {
    const detail = (error as TrzszInvokeError).detail;
    return typeof detail === 'string' && detail.length > 0 ? detail : undefined;
  }

  return undefined;
}

export function isTrzszCancelledError(error: unknown): boolean {
  const code = getTrzszErrorCode(error);
  if (code === 'user_cancelled') {
    return true;
  }

  if (error instanceof Error) {
    return error.message === 'Stopped'
      || error.message === 'Interrupted'
      || error.message === 'Stopped and deleted';
  }

  return false;
}

export function parseTrzszDirectoryEntry(raw: string): TrzszDirectoryEntry {
  const payload = JSON.parse(raw) as {
    path_id?: unknown;
    path_name?: unknown;
    is_dir?: unknown;
  };

  if (!Array.isArray(payload.path_name) || payload.path_name.length === 0) {
    throw new Error(`Invalid trzsz directory entry payload: ${raw}`);
  }

  return {
    pathId: Number(payload.path_id),
    pathName: payload.path_name.map((value) => String(value)),
    isDir: payload.is_dir === true,
  };
}