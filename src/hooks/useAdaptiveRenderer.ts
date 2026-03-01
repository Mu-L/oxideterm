/**
 * useAdaptiveRenderer — Dynamic Refresh Rate scheduler for terminal rendering.
 *
 * Replaces the fixed-RAF batching pattern (`pendingDataRef` + `rafIdRef`) with
 * a three-tier adaptive pipeline:
 *
 * | Tier      | Trigger                              | Effective FPS | Benefit                        |
 * |-----------|--------------------------------------|---------------|--------------------------------|
 * | **boost** | High throughput / rapid scroll        | 120Hz+ (RAF)  | Eliminates motion blur          |
 * | **normal**| Standard typing / light output        | 60Hz (RAF)    | Baseline interactive smoothness |
 * | **idle**  | No I/O for 3s, or window hidden/blur  | 1–15Hz (timer)| GPU idle, battery savings       |
 *
 * ## How it works
 *
 * - Callers push data via `scheduleWrite(chunk)`.
 * - In **boost / normal** mode, a single `requestAnimationFrame` collects all
 *   pending chunks and issues one `terminal.write(combined)`.
 *   On ≥120Hz displays the browser naturally fires RAF at the panel refresh
 *   rate — no extra timers needed.
 * - In **idle** mode, RAF is cancelled and a `setTimeout` loop fires at a
 *   progressively slower interval (66ms → 1000ms) to keep cursors blinking
 *   and late output visible without GPU load.
 * - Transitions are driven by data volume, user input, and Page Visibility /
 *   window focus events.
 *
 * The hook is **framework-agnostic** in its core — it returns a plain object
 * and manages its own listeners.  React is only used for lifecycle cleanup.
 */

import { useRef, useEffect, useCallback, useMemo } from 'react';
import type { Terminal } from '@xterm/xterm';

// ─── Types ────────────────────────────────────────────────────────────

export type RenderTier = 'boost' | 'normal' | 'idle';

export type AdaptiveRendererMode = 'auto' | 'always-60' | 'off';

export type AdaptiveRendererStats = {
  tier: RenderTier;
  /** Measured writes-per-second (rolling window) */
  actualWps: number;
  /** Bytes pending in the current batch */
  pendingBytes: number;
};

// ─── Constants ────────────────────────────────────────────────────────

/** Bytes per frame that triggers boost mode (4 KB) */
const BOOST_BYTES_THRESHOLD = 4096;

/** Consecutive low-volume frames before dropping from boost → normal */
const BOOST_COOLDOWN_FRAMES = 30; // ~500ms at 60fps

/** Milliseconds of silence before transitioning normal → idle */
const IDLE_TIMEOUT_MS = 3_000;

/** Idle tier minimum interval (≈15 fps) */
const IDLE_INTERVAL_MIN_MS = 66;

/** Idle tier maximum interval (1 fps) */
const IDLE_INTERVAL_MAX_MS = 1_000;

/** Idle interval growth factor per tick */
const IDLE_INTERVAL_GROWTH = 1.5;

// ─── Hook ─────────────────────────────────────────────────────────────

type UseAdaptiveRendererOptions = {
  /** Ref to the xterm Terminal instance (null until mounted) */
  terminalRef: React.RefObject<Terminal | null>;
  /** Feature mode from settings */
  mode: AdaptiveRendererMode;
};

export type AdaptiveRendererHandle = {
  /**
   * Enqueue a chunk for the next batched `terminal.write()`.
   * Call this instead of `terminal.write()` directly.
   */
  scheduleWrite: (data: Uint8Array) => void;
  /** Signal that the user pressed a key / interacted */
  notifyUserInput: () => void;
  /** Current tier (for UI / profiler) */
  getTier: () => RenderTier;
  /** Get stats snapshot */
  getStats: () => AdaptiveRendererStats;
};

export function useAdaptiveRenderer(opts: UseAdaptiveRendererOptions): AdaptiveRendererHandle {
  const { terminalRef, mode } = opts;

  // Track mode in a ref so callbacks always see the latest value
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // ── Internal state (refs for zero-render-cost) ────────────────────

  const pendingRef = useRef<Uint8Array[]>([]);
  const rafIdRef = useRef<number | null>(null);
  const timerIdRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tierRef = useRef<RenderTier>('normal');

  // Boost cooldown counter: counts consecutive low-volume frames
  const boostCooldownRef = useRef(0);

  // Idle transition timer
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Current idle interval (grows over time)
  const idleIntervalRef = useRef(IDLE_INTERVAL_MIN_MS);

  // WPS tracking (rolling window)
  const writeTimestampsRef = useRef<number[]>([]);

  // Track whether we're "alive" (component mounted)
  const mountedRef = useRef(true);

  // ── Helpers ───────────────────────────────────────────────────────

  /** Concatenate all pending chunks and write to terminal in one call. */
  const flush = useCallback(() => {
    const term = terminalRef.current;
    const pending = pendingRef.current;
    if (!term || pending.length === 0) return;

    const totalLength = pending.reduce((acc, arr) => acc + arr.length, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of pending) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    pendingRef.current = [];
    term.write(combined);

    // Track WPS
    const now = performance.now();
    writeTimestampsRef.current.push(now);
    // Keep only last 2 seconds of timestamps
    const cutoff = now - 2_000;
    while (writeTimestampsRef.current.length > 0 && writeTimestampsRef.current[0] < cutoff) {
      writeTimestampsRef.current.shift();
    }
  }, [terminalRef]);

  // ── Tier transition logic ─────────────────────────────────────────

  const cancelIdle = useCallback(() => {
    if (timerIdRef.current !== null) {
      clearTimeout(timerIdRef.current);
      timerIdRef.current = null;
    }
    idleIntervalRef.current = IDLE_INTERVAL_MIN_MS;
  }, []);

  const cancelRaf = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
  }, []);

  const resetIdleTimer = useCallback(() => {
    if (idleTimerRef.current !== null) {
      clearTimeout(idleTimerRef.current);
    }
    idleTimerRef.current = setTimeout(() => {
      if (!mountedRef.current) return;
      enterIdle();
    }, IDLE_TIMEOUT_MS);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const enterIdle = useCallback(() => {
    if (tierRef.current === 'idle') return;
    tierRef.current = 'idle';
    cancelRaf();
    idleIntervalRef.current = IDLE_INTERVAL_MIN_MS;
    scheduleIdleTick();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const scheduleIdleTick = useCallback(() => {
    if (timerIdRef.current !== null) return;
    timerIdRef.current = setTimeout(() => {
      timerIdRef.current = null;
      if (!mountedRef.current) return;

      flush();

      if (tierRef.current === 'idle') {
        // Grow interval towards max
        idleIntervalRef.current = Math.min(
          idleIntervalRef.current * IDLE_INTERVAL_GROWTH,
          IDLE_INTERVAL_MAX_MS,
        );
        scheduleIdleTick();
      }
    }, idleIntervalRef.current);
  }, [flush]); // eslint-disable-line react-hooks/exhaustive-deps

  const exitIdle = useCallback(() => {
    if (tierRef.current !== 'idle') return;
    cancelIdle();
    tierRef.current = 'normal';
    boostCooldownRef.current = 0;
  }, [cancelIdle]);

  /** Evaluate whether the current frame should be boost or stay normal */
  const evaluateBoost = useCallback((bytesThisFrame: number) => {
    if (bytesThisFrame >= BOOST_BYTES_THRESHOLD) {
      tierRef.current = 'boost';
      boostCooldownRef.current = 0;
    } else if (tierRef.current === 'boost') {
      boostCooldownRef.current++;
      if (boostCooldownRef.current >= BOOST_COOLDOWN_FRAMES) {
        tierRef.current = 'normal';
        boostCooldownRef.current = 0;
      }
    }
  }, []);

  // ── scheduleWrite ─────────────────────────────────────────────────

  const scheduleWrite = useCallback(
    (data: Uint8Array) => {
      if (!terminalRef.current || !mountedRef.current) return;

      const currentMode = modeRef.current;

      // Mode: 'off' — direct write, no batching
      if (currentMode === 'off') {
        terminalRef.current.write(data);
        return;
      }

      // If currently idle AND the page is hidden (or window has no focus),
      // stay in idle — just push data and let the idle timer flush it.
      // This prevents waking to RAF mode under continuous remote output
      // while the tab is backgrounded, which would accumulate large pending
      // buffers since RAF is throttled/suspended in background tabs.
      if (tierRef.current === 'idle' && document.hidden) {
        pendingRef.current.push(data);
        // Reset idle interval to min so data gets flushed soon
        idleIntervalRef.current = IDLE_INTERVAL_MIN_MS;
        // Ensure an idle tick is scheduled
        scheduleIdleTick();
        return;
      }

      // Wake from idle if needed (only when page is visible)
      if (tierRef.current === 'idle') {
        exitIdle();
      }

      // Push to pending buffer
      pendingRef.current.push(data);

      // Reset idle countdown
      resetIdleTimer();

      // Mode: 'always-60' — simple RAF, no boost evaluation
      if (currentMode === 'always-60') {
        if (rafIdRef.current === null) {
          rafIdRef.current = requestAnimationFrame(() => {
            rafIdRef.current = null;
            if (!mountedRef.current) return;
            flush();
          });
        }
        return;
      }

      // Mode: 'auto' — adaptive RAF with boost evaluation
      if (rafIdRef.current === null) {
        rafIdRef.current = requestAnimationFrame(() => {
          rafIdRef.current = null;
          if (!mountedRef.current) return;

          // Calculate bytes in this frame for boost decision
          const totalBytes = pendingRef.current.reduce((s, c) => s + c.length, 0);
          evaluateBoost(totalBytes);

          flush();
        });
      }
    },
    [terminalRef, flush, exitIdle, resetIdleTimer, evaluateBoost, scheduleIdleTick],
  );

  // ── notifyUserInput ───────────────────────────────────────────────

  const notifyUserInput = useCallback(() => {
    if (tierRef.current === 'idle') {
      exitIdle();
    }
    resetIdleTimer();
  }, [exitIdle, resetIdleTimer]);

  // ── Visibility / focus listeners ──────────────────────────────────

  useEffect(() => {
    if (modeRef.current === 'off') return;

    const handleVisibilityChange = () => {
      if (modeRef.current === 'off') return;
      if (document.hidden) {
        // Page hidden → enter idle immediately
        if (idleTimerRef.current !== null) {
          clearTimeout(idleTimerRef.current);
          idleTimerRef.current = null;
        }
        enterIdle();
      } else {
        // Page visible → exit idle, resume normal
        exitIdle();
        resetIdleTimer();
        // If there's pending data, kick a RAF
        if (pendingRef.current.length > 0 && rafIdRef.current === null) {
          rafIdRef.current = requestAnimationFrame(() => {
            rafIdRef.current = null;
            if (!mountedRef.current) return;
            flush();
          });
        }
      }
    };

    const handleWindowBlur = () => {
      // Start a fast-track to idle when the user switches apps (3s still applies)
      resetIdleTimer();
    };

    const handleWindowFocus = () => {
      if (tierRef.current === 'idle') {
        exitIdle();
        resetIdleTimer();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('blur', handleWindowBlur);
    window.addEventListener('focus', handleWindowFocus);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('blur', handleWindowBlur);
      window.removeEventListener('focus', handleWindowFocus);
    };
  }, [enterIdle, exitIdle, resetIdleTimer, flush]);

  // ── Cleanup on unmount ────────────────────────────────────────────

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelRaf();
      cancelIdle();
      if (idleTimerRef.current !== null) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      pendingRef.current = [];
    };
  }, [cancelRaf, cancelIdle]);

  // ── Public API ────────────────────────────────────────────────────

  const getTier = useCallback(() => tierRef.current, []);

  const getStats = useCallback((): AdaptiveRendererStats => {
    const now = performance.now();
    const cutoff = now - 1_000;
    const recentWrites = writeTimestampsRef.current.filter((t) => t >= cutoff);
    return {
      tier: tierRef.current,
      actualWps: recentWrites.length,
      pendingBytes: pendingRef.current.reduce((s, c) => s + c.length, 0),
    };
  }, []);

  return useMemo(
    () => ({ scheduleWrite, notifyUserInput, getTier, getStats }),
    [scheduleWrite, notifyUserInput, getTier, getStats],
  );
}
