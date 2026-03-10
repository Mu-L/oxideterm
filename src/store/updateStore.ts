/**
 * Update Store — Zustand store with persist for resumable updater.
 *
 * Manages the full update lifecycle: check → download → verify → install → restart.
 * Supports resumable downloads via Rust backend, with graceful fallback to legacy plugin.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { retryWithExponentialBackoff } from '@/lib/retry';

// ── Types ───────────────────────────────────────────────────

export type UpdateStage =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'verifying'
  | 'installing'
  | 'ready'
  | 'up-to-date'
  | 'error'
  | 'cancelled';

type ResumableUpdateStatus = {
  taskId: string;
  version: string;
  attempt: number;
  downloadedBytes: number;
  totalBytes: number | null;
  resumable: boolean;
  stage: string;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  timestamp: number;
  retryDelayMs: number | null;
  lastHttpStatus: number | null;
  canResumeAfterRestart: boolean;
};

type ResumableEvent = {
  type: 'started' | 'resumed' | 'progress' | 'retrying' | 'verifying' | 'installing' | 'ready' | 'error' | 'cancelled';
} & ResumableUpdateStatus;

type PersistedState = {
  lastCheckedAt: number | null;
  skippedVersion: string | null;
};

type UpdateState = PersistedState & {
  // Transient state (not persisted)
  stage: UpdateStage;
  newVersion: string | null;
  currentVersion: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
  errorMessage: string | null;
  resumableTaskId: string | null;
  attempt: number;
  retryDelayMs: number | null;

  // Actions
  checkForUpdate: (opts?: { silent?: boolean }) => Promise<void>;
  startDownload: () => Promise<void>;
  cancelDownload: () => Promise<void>;
  restartApp: () => Promise<void>;
  dismiss: () => void;
  skipVersion: (version: string) => void;
  clearSkippedVersion: () => void;
  initAutoUpdateCheck: (delayMs?: number) => void;
  initResumableListeners: () => UnlistenFn;
};

// ── Store ───────────────────────────────────────────────────

let _updateRef: Update | null = null;
let _autoCheckTimer: ReturnType<typeof setTimeout> | null = null;

type SetFn = (partial: Partial<UpdateState>) => void;
type GetFn = () => UpdateState;

/** Legacy fallback: download via plugin-updater when resumable backend is unavailable */
async function legacyDownload(set: SetFn, get: GetFn) {
  const update = _updateRef;
  if (!update) {
    set({ stage: 'error', errorMessage: 'No update reference available' });
    return;
  }

  set({ stage: 'downloading', downloadedBytes: 0, totalBytes: null });
  try {
    let totalLen = 0;
    let downloaded = 0;
    await update.downloadAndInstall((event) => {
      if (event.event === 'Started') {
        totalLen = event.data.contentLength ?? 0;
        set({ totalBytes: totalLen || null });
      } else if (event.event === 'Progress') {
        downloaded += event.data.chunkLength;
        set({ downloadedBytes: downloaded });
      } else if (event.event === 'Finished') {
        set({ downloadedBytes: totalLen, stage: 'ready' });
      }
    });
    // Fallback if Finished event didn't fire
    if (get().stage !== 'ready') {
      set({ stage: 'ready', downloadedBytes: totalLen });
    }
  } catch (err) {
    set({
      stage: 'error',
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}

export const useUpdateStore = create<UpdateState>()(
  persist(
    (set, get) => ({
      // Persisted
      lastCheckedAt: null,
      skippedVersion: null,

      // Transient
      stage: 'idle' as UpdateStage,
      newVersion: null,
      currentVersion: null,
      downloadedBytes: 0,
      totalBytes: null,
      errorMessage: null,
      resumableTaskId: null,
      attempt: 0,
      retryDelayMs: null,

      // ── Check ───────────────────────────────────────────

      checkForUpdate: async (opts) => {
        const silent = opts?.silent ?? false;
        set({ stage: 'checking', errorMessage: null });

        try {
          const update = await retryWithExponentialBackoff(
            () => check(),
            { maxRetries: 2, baseDelayMs: 2000 },
          );

          if (update) {
            _updateRef = update;
            const { skippedVersion } = get();
            if (silent && skippedVersion === update.version) {
              set({ stage: 'idle', lastCheckedAt: Date.now() });
              return;
            }
            set({
              stage: 'available',
              newVersion: update.version,
              currentVersion: update.currentVersion,
              lastCheckedAt: Date.now(),
            });
          } else {
            _updateRef = null;
            set({ stage: 'up-to-date', lastCheckedAt: Date.now() });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // 404 / network errors / dev mode: treat as up-to-date
          if (silent && /404|not found|fetch|network|endpoint/i.test(msg)) {
            set({ stage: 'idle', lastCheckedAt: Date.now() });
            return;
          }
          if (/404|not found|fetch|network|endpoint/i.test(msg)) {
            set({ stage: 'up-to-date', lastCheckedAt: Date.now() });
          } else {
            set({ stage: 'error', errorMessage: msg, lastCheckedAt: Date.now() });
          }
        }
      },

      // ── Download (resumable backend) ────────────────────

      startDownload: async () => {
        const { newVersion } = get();
        if (!newVersion) return;

        set({
          stage: 'downloading',
          downloadedBytes: 0,
          totalBytes: null,
          errorMessage: null,
          attempt: 1,
          retryDelayMs: null,
        });

        try {
          const taskId = await invoke<string>('update_start_resumable_install', {
            expectedVersion: newVersion,
          });
          set({ resumableTaskId: taskId });
          // Progress will be tracked via event listener
        } catch (err) {
          // Resumable backend not available — fallback to legacy plugin
          console.warn('[update] Resumable install failed, falling back to legacy:', err);
          await legacyDownload(set, get);
        }
      },

      // ── Cancel ──────────────────────────────────────────

      cancelDownload: async () => {
        const { resumableTaskId } = get();
        try {
          if (resumableTaskId) {
            await invoke('update_cancel_resumable_install', { taskId: resumableTaskId });
          }
        } catch {
          // Ignore cancel errors
        }
        set({
          stage: 'idle',
          resumableTaskId: null,
          downloadedBytes: 0,
          totalBytes: null,
          errorMessage: null,
        });
      },

      // ── Restart ─────────────────────────────────────────

      restartApp: async () => {
        await relaunch();
      },

      // ── UI actions ──────────────────────────────────────

      dismiss: () => {
        set({ stage: 'idle', errorMessage: null });
      },

      skipVersion: (version: string) => {
        set({ skippedVersion: version, stage: 'idle' });
      },

      clearSkippedVersion: () => {
        set({ skippedVersion: null });
      },

      // ── Auto-check on startup ───────────────────────────

      initAutoUpdateCheck: (delayMs = 8000) => {
        if (_autoCheckTimer) clearTimeout(_autoCheckTimer);
        _autoCheckTimer = setTimeout(() => {
          get().checkForUpdate({ silent: true });
          _autoCheckTimer = null;
        }, delayMs);
      },

      // ── Resumable event listener ────────────────────────

      initResumableListeners: () => {
        let unlisten: UnlistenFn | null = null;

        const setup = async () => {
          unlisten = await listen<ResumableEvent>('update:resumable-event', (event) => {
            const payload = event.payload;

            switch (payload.type) {
              case 'started':
              case 'resumed':
                set({
                  stage: 'downloading',
                  resumableTaskId: payload.taskId,
                  downloadedBytes: payload.downloadedBytes,
                  totalBytes: payload.totalBytes,
                  attempt: payload.attempt,
                });
                break;

              case 'progress':
                set({
                  downloadedBytes: payload.downloadedBytes,
                  totalBytes: payload.totalBytes,
                });
                break;

              case 'retrying':
                set({
                  attempt: payload.attempt,
                  retryDelayMs: payload.retryDelayMs,
                });
                break;

              case 'verifying':
                set({ stage: 'verifying' });
                break;

              case 'installing':
                set({ stage: 'installing' });
                break;

              case 'ready':
                set({
                  stage: 'ready',
                  downloadedBytes: payload.downloadedBytes,
                  totalBytes: payload.totalBytes,
                });
                break;

              case 'error':
                set({
                  stage: 'error',
                  errorMessage: payload.errorMessage || 'Unknown error',
                });
                break;

              case 'cancelled':
                set({
                  stage: 'idle',
                  resumableTaskId: null,
                  downloadedBytes: 0,
                  totalBytes: null,
                });
                break;
            }
          });
        };

        setup();

        return () => {
          unlisten?.();
        };
      },
    }),
    {
      name: 'oxide-update-store',
      storage: createJSONStorage(() => localStorage),
      partialize: (state): PersistedState => ({
        lastCheckedAt: state.lastCheckedAt,
        skippedVersion: state.skippedVersion,
      }),
    },
  ),
);
