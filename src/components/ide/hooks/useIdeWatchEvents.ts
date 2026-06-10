import { useEffect, useRef } from 'react';
import type { AgentMode } from './useAgentStatus';
import type { AgentWatchEvent } from '../../../types';
import * as agentService from '../../../lib/agentService';
import { getParentPath, normalizePath } from '../../../lib/pathUtils';
import { triggerGitRefresh, triggerSearchCacheClear, useIdeStore } from '../../../store/ideStore';

const WATCH_RETRY_MS = 3000;
const WATCH_BATCH_MS = 150;
// Large recursive deletes can emit hundreds of watch events for the same visible directory.
const WATCH_REFRESH_COOLDOWN_MS = 750;

type UseIdeWatchEventsOptions = {
  nodeId: string;
  rootPath: string | undefined;
  enabled: boolean;
  mode: AgentMode;
};

// Collapse hidden-directory descendants (for example .git/objects/...) to the
// nearest visible parent so one recursive delete does not churn many tree nodes.
function watchRefreshPath(eventPath: string, rootPath: string): string {
  const normalizedEventPath = normalizePath(eventPath);
  const normalizedRootPath = normalizePath(rootPath);

  if (normalizedEventPath === normalizedRootPath) {
    return normalizedRootPath;
  }

  const rootPrefix = normalizedRootPath.endsWith('/') ? normalizedRootPath : `${normalizedRootPath}/`;
  if (normalizedEventPath.startsWith(rootPrefix)) {
    const relativeParts = normalizedEventPath.slice(rootPrefix.length).split('/').filter(Boolean);
    const hiddenIndex = relativeParts.findIndex(part => part.startsWith('.') && part.length > 1);

    if (hiddenIndex >= 0) {
      const visibleParentParts = relativeParts.slice(0, hiddenIndex);
      return visibleParentParts.length === 0
        ? normalizedRootPath
        : normalizePath(`${rootPrefix}${visibleParentParts.join('/')}`);
    }
  }

  return getParentPath(normalizedEventPath);
}

export function useIdeWatchEvents({
  nodeId,
  rootPath,
  enabled,
  mode,
}: UseIdeWatchEventsOptions): void {
  const refreshTreeNode = useIdeStore((state) => state.refreshTreeNode);
  const refreshTreeNodeRef = useRef(refreshTreeNode);

  refreshTreeNodeRef.current = refreshTreeNode;

  useEffect(() => {
    if (!enabled || mode !== 'agent' || !rootPath) {
      return;
    }

    let disposed = false;
    let activeUnlisten: (() => void | Promise<void>) | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const pendingRefreshPaths = new Set<string>();
    const lastRefreshAt = new Map<string, number>();
    const normalizedRootPath = normalizePath(rootPath);

    const flushPendingRefreshes = () => {
      flushTimer = null;
      if (pendingRefreshPaths.size === 0) {
        return;
      }

      const now = Date.now();
      let nextDelay: number | null = null;
      let didRefresh = false;

      for (const path of Array.from(pendingRefreshPaths)) {
        const last = lastRefreshAt.get(path);
        const elapsed = last === undefined ? WATCH_REFRESH_COOLDOWN_MS : now - last;
        if (last !== undefined && elapsed < WATCH_REFRESH_COOLDOWN_MS) {
          const remaining = WATCH_REFRESH_COOLDOWN_MS - elapsed;
          nextDelay = nextDelay === null ? remaining : Math.min(nextDelay, remaining);
          continue;
        }

        refreshTreeNodeRef.current(path);
        lastRefreshAt.set(path, now);
        pendingRefreshPaths.delete(path);
        didRefresh = true;
      }

      if (didRefresh) {
        triggerGitRefresh();
        triggerSearchCacheClear();
      }

      if (pendingRefreshPaths.size > 0) {
        flushTimer = setTimeout(flushPendingRefreshes, nextDelay ?? WATCH_BATCH_MS);
      }
    };

    const queueRefresh = (event: AgentWatchEvent) => {
      pendingRefreshPaths.add(watchRefreshPath(event.path, normalizedRootPath));
      if (!flushTimer) {
        flushTimer = setTimeout(flushPendingRefreshes, WATCH_BATCH_MS);
      }
    };

    const scheduleRetry = () => {
      if (disposed || retryTimer || activeUnlisten) {
        return;
      }

      retryTimer = setTimeout(() => {
        retryTimer = null;
        void startWatching();
      }, WATCH_RETRY_MS);
    };

    const startWatching = async () => {
      if (disposed || activeUnlisten) {
        return;
      }

      const unlisten = await agentService.watchDirectory(
        nodeId,
        normalizedRootPath,
        queueRefresh,
      );

      if (disposed) {
        await unlisten?.();
        return;
      }

      if (!unlisten) {
        scheduleRetry();
        return;
      }

      activeUnlisten = unlisten;
    };

    void startWatching();

    return () => {
      disposed = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      if (flushTimer) {
        clearTimeout(flushTimer);
      }
      pendingRefreshPaths.clear();
      lastRefreshAt.clear();

      const unlisten = activeUnlisten;
      activeUnlisten = null;
      void unlisten?.();
    };
  }, [enabled, mode, nodeId, rootPath]);
}
