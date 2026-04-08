import type { TransferDirection, TransferItem } from '@/store/transferStore';

type ProgressMatchCandidate = Pick<TransferItem, 'id' | 'localPath' | 'remotePath'>;

export type ProgressEventMatchPayload = {
  id: string;
  local_path: string;
  remote_path: string;
};

export type PreviewResource = {
  tempPath?: string;
} | null;

export function normalizeSftpTransferPath(path: string): string {
  if (!path) {
    return '';
  }

  const normalized = path.replace(/\/+/g, '/').replace(/\/$/, '');
  return normalized || '/';
}

function findUniquePathCandidate(
  transfers: ProgressMatchCandidate[],
  key: 'localPath' | 'remotePath',
  targetPath: string,
): ProgressMatchCandidate | undefined {
  const candidates = transfers.filter(
    (transfer) => normalizeSftpTransferPath(transfer[key]) === targetPath,
  );

  return candidates.length === 1 ? candidates[0] : undefined;
}

export function findTransferForProgressEvent<T extends ProgressMatchCandidate>(
  transfers: T[],
  event: ProgressEventMatchPayload,
): T | undefined {
  const byId = transfers.find((transfer) => transfer.id === event.id);
  if (byId) {
    return byId;
  }

  const normalizedRemote = normalizeSftpTransferPath(event.remote_path);
  const normalizedLocal = normalizeSftpTransferPath(event.local_path);

  const exactPathMatch = transfers.find((transfer) => {
    const transferRemote = normalizeSftpTransferPath(transfer.remotePath);
    const transferLocal = normalizeSftpTransferPath(transfer.localPath);
    return transferRemote === normalizedRemote && transferLocal === normalizedLocal;
  });

  if (exactPathMatch) {
    return exactPathMatch;
  }

  const byRemote = findUniquePathCandidate(transfers, 'remotePath', normalizedRemote);
  if (byRemote) {
    return byRemote;
  }

  return findUniquePathCandidate(transfers, 'localPath', normalizedLocal);
}

export function getTransferCompletionRefreshPlan(direction?: TransferDirection | null): {
  refreshLocal: boolean;
  refreshRemote: boolean;
} {
  if (direction === 'upload') {
    return { refreshLocal: false, refreshRemote: true };
  }

  if (direction === 'download') {
    return { refreshLocal: true, refreshRemote: false };
  }

  return { refreshLocal: true, refreshRemote: true };
}

export async function cleanupPreviewResource(
  preview: PreviewResource,
  cleanup: (path: string) => Promise<unknown>,
): Promise<void> {
  if (!preview?.tempPath) {
    return;
  }

  try {
    await cleanup(preview.tempPath);
  } catch {
    // Best-effort temp cleanup; preview closing should not fail the UI flow.
  }
}