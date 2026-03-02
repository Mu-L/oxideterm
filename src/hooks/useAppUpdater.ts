import { useState, useCallback, useEffect, useRef } from 'react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'up-to-date'
  | 'error';

type UpdateState = {
  status: UpdateStatus;
  newVersion: string | null;
  currentVersion: string | null;
  downloadProgress: number;         // 0–100
  errorMessage: string | null;
  /** 距上次检查的时间戳（ms） */
  lastCheckedAt: number | null;
};

const INITIAL_STATE: UpdateState = {
  status: 'idle',
  newVersion: null,
  currentVersion: null,
  downloadProgress: 0,
  errorMessage: null,
  lastCheckedAt: null,
};

/**
 * 应用内自动更新 hook。
 *
 * 更新流程：
 *   check() → 有更新 → downloadAndInstall() → 提示重启
 *
 * 更新包通过 Ed25519 签名验证完整性（非 Apple 代码签名）。
 * 应用内更新不经浏览器下载，不会被 macOS Gatekeeper 隔离，
 * 因此安装后无需 xattr -cr。
 */
export function useAppUpdater() {
  const [state, setState] = useState<UpdateState>(INITIAL_STATE);
  const updateRef = useRef<Update | null>(null);

  // ── 检查更新 ──────────────────────────────────────────────
  const checkForUpdate = useCallback(async () => {
    setState(s => ({ ...s, status: 'checking', errorMessage: null }));
    try {
      const update = await check();
      if (update) {
        updateRef.current = update;
        setState(s => ({
          ...s,
          status: 'available',
          newVersion: update.version,
          currentVersion: update.currentVersion,
          lastCheckedAt: Date.now(),
        }));
      } else {
        updateRef.current = null;
        setState(s => ({
          ...s,
          status: 'up-to-date',
          lastCheckedAt: Date.now(),
        }));
      }
    } catch (err) {
      setState(s => ({
        ...s,
        status: 'error',
        errorMessage: err instanceof Error ? err.message : String(err),
        lastCheckedAt: Date.now(),
      }));
    }
  }, []);

  // ── 下载并安装 ────────────────────────────────────────────
  const downloadAndInstall = useCallback(async () => {
    const update = updateRef.current;
    if (!update) return;

    setState(s => ({ ...s, status: 'downloading', downloadProgress: 0 }));

    try {
      let totalLen = 0;
      let downloaded = 0;

      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          totalLen = event.data.contentLength ?? 0;
        } else if (event.event === 'Progress') {
          downloaded += event.data.chunkLength;
          const pct = totalLen > 0 ? Math.round((downloaded / totalLen) * 100) : 0;
          setState(s => ({ ...s, downloadProgress: pct }));
        } else if (event.event === 'Finished') {
          setState(s => ({ ...s, downloadProgress: 100, status: 'ready' }));
        }
      });

      // 如果 Finished 事件未触发也兜底
      setState(s => (s.status !== 'ready' ? { ...s, status: 'ready', downloadProgress: 100 } : s));
    } catch (err) {
      setState(s => ({
        ...s,
        status: 'error',
        errorMessage: err instanceof Error ? err.message : String(err),
      }));
    }
  }, []);

  // ── 重启应用 ──────────────────────────────────────────────
  const restartApp = useCallback(async () => {
    await relaunch();
  }, []);

  // ── 重置状态（用于关闭提示后再次显示按钮） ────────────────
  const dismiss = useCallback(() => {
    setState(s => ({ ...s, status: 'idle' }));
  }, []);

  // ── 启动后静默检查（延迟 8 秒，仅一次） ──────────────────
  useEffect(() => {
    const timer = setTimeout(() => {
      checkForUpdate().catch(() => { /* 静默失败 */ });
    }, 8_000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    ...state,
    checkForUpdate,
    downloadAndInstall,
    restartApp,
    dismiss,
  };
}
