// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import { create } from 'zustand';
import { api } from '@/lib/api';
import {
  collectFrontendMemoryDiagnostics,
  sanitizeMemoryDiagnosticsForExport,
  type MemoryDiagnosticsSnapshot,
} from '@/lib/diagnostics/memoryDiagnosticsRegistry';

const MAX_MEMORY_DIAGNOSTIC_SAMPLES = 300;

interface MemoryDiagnosticsStore {
  latest: MemoryDiagnosticsSnapshot | null;
  samples: MemoryDiagnosticsSnapshot[];
  loading: boolean;
  error: string | null;
  recording: boolean;
  refresh: () => Promise<MemoryDiagnosticsSnapshot | null>;
  startRecording: () => void;
  stopRecording: () => void;
  clearSamples: () => void;
  exportReport: () => string | null;
}

let intervalId: ReturnType<typeof setInterval> | null = null;

function stopTimer(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

export const useMemoryDiagnosticsStore = create<MemoryDiagnosticsStore>((set, get) => ({
  latest: null,
  samples: [],
  loading: false,
  error: null,
  recording: false,

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const backend = await api.getMemoryDiagnostics();
      const snapshot: MemoryDiagnosticsSnapshot = {
        capturedAt: Date.now(),
        backend,
        frontend: collectFrontendMemoryDiagnostics(),
      };
      set((state) => ({
        latest: snapshot,
        samples: [...state.samples, snapshot].slice(-MAX_MEMORY_DIAGNOSTIC_SAMPLES),
        loading: false,
        error: null,
      }));
      return snapshot;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      set({ loading: false, error: message });
      return null;
    }
  },

  startRecording: () => {
    if (intervalId) return;
    set({ recording: true });
    void get().refresh();
    intervalId = setInterval(() => {
      void get().refresh();
    }, 2000);
  },

  stopRecording: () => {
    stopTimer();
    set({ recording: false });
  },

  clearSamples: () => set({ samples: [] }),

  exportReport: () => {
    const latest = get().latest;
    if (!latest) return null;
    return JSON.stringify({
      schema: 'oxideterm.memory-diagnostics.v1',
      exportedAt: Date.now(),
      latest: sanitizeMemoryDiagnosticsForExport(latest),
      samples: get().samples.map(sanitizeMemoryDiagnosticsForExport),
    }, null, 2);
  },
}));
