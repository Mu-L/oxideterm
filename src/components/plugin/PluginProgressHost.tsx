// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { pluginEventBridge } from '@/lib/plugin/pluginEventBridge';
import { cn } from '@/lib/utils';

type ProgressEntry = {
  id: string;
  pluginId: string;
  title: string;
  progress: number;
  message?: string;
};

type ProgressStartPayload = {
  id?: string;
  pluginId?: string;
  title?: string;
};

type ProgressUpdatePayload = {
  id?: string;
  progress?: number;
  message?: string;
};

const COMPLETE_DISMISS_DELAY_MS = 1200;

export function PluginProgressHost() {
  const [entries, setEntries] = useState<Map<string, ProgressEntry>>(new Map());
  const dismissTimersRef = useRef<Map<string, number>>(new Map());
  const completedEntriesRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const clearDismissTimer = (id: string) => {
      const timer = dismissTimersRef.current.get(id);
      if (timer !== undefined) {
        window.clearTimeout(timer);
        dismissTimersRef.current.delete(id);
      }
    };

    const scheduleDismiss = (id: string) => {
      clearDismissTimer(id);
      const timer = window.setTimeout(() => {
        dismissTimersRef.current.delete(id);
        completedEntriesRef.current.delete(id);
        setEntries((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Map(prev);
          next.delete(id);
          return next;
        });
      }, COMPLETE_DISMISS_DELAY_MS);
      dismissTimersRef.current.set(id, timer);
    };

    const startCleanup = pluginEventBridge.on('plugin:progress:start', (data) => {
      const payload = data as ProgressStartPayload;
      if (!payload.id || !payload.title || !payload.pluginId) return;
      const progressId = payload.id;
      const pluginId = payload.pluginId;
      const title = payload.title;

      completedEntriesRef.current.delete(progressId);
      clearDismissTimer(progressId);
      setEntries((prev) => {
        const next = new Map(prev);
        next.set(progressId, {
          id: progressId,
          pluginId,
          title,
          progress: 0,
        });
        return next;
      });
    });

    const updateCleanup = pluginEventBridge.on('plugin:progress:update', (data) => {
      const payload = data as ProgressUpdatePayload;
      if (!payload.id) return;
      const progressId = payload.id;
      if (completedEntriesRef.current.has(progressId)) return;

      setEntries((prev) => {
        const existing = prev.get(progressId);
        if (!existing) return prev;

        const next = new Map(prev);
        next.set(progressId, {
          ...existing,
          progress: Math.max(0, Math.min(100, payload.progress ?? existing.progress)),
          message: payload.message,
        });
        return next;
      });

      if ((payload.progress ?? 0) >= 100) {
        completedEntriesRef.current.add(progressId);
        scheduleDismiss(progressId);
      } else {
        clearDismissTimer(progressId);
      }
    });

    return () => {
      startCleanup();
      updateCleanup();
      for (const timer of dismissTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      dismissTimersRef.current.clear();
    };
  }, []);

  const visibleEntries = useMemo(() => Array.from(entries.values()).slice(-4), [entries]);

  if (visibleEntries.length === 0) return null;

  return (
    <div className="pointer-events-none fixed right-4 top-4 z-[70] flex w-[320px] max-w-[calc(100vw-2rem)] flex-col gap-2">
      {visibleEntries.map((entry) => (
        <div
          key={entry.id}
          className={cn(
            'rounded-lg border border-theme-border bg-theme-bg-elevated/95 p-3 shadow-xl backdrop-blur-sm',
            entry.progress >= 100 && 'border-emerald-500/40',
          )}
        >
          <div className="flex items-start gap-2">
            <Loader2 className={cn('mt-0.5 h-4 w-4 shrink-0 text-theme-accent', entry.progress < 100 && 'animate-spin')} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-3">
                <span className="truncate text-sm font-medium text-theme-text">{entry.title}</span>
                <span className="shrink-0 text-xs text-theme-text-muted">{entry.progress}%</span>
              </div>
              {entry.message && (
                <div className="mt-1 truncate text-xs text-theme-text-muted">{entry.message}</div>
              )}
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-theme-bg-panel">
                <div
                  className="h-full rounded-full bg-theme-accent transition-[width] duration-200"
                  style={{ width: `${entry.progress}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}