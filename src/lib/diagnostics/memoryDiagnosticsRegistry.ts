// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import type { MemoryDiagnosticsBackendSnapshot } from '@/types';

export type MemoryDiagnosticsRisk = 'low' | 'medium' | 'high';

export interface MemoryDiagnosticsProviderSnapshot {
  id: string;
  label: string;
  category: 'terminal' | 'scrollback' | 'ai' | 'ide' | 'sftp' | 'gpu' | 'events' | 'plugins' | 'other';
  objectCount: number;
  estimatedBytes: number | null;
  risk?: MemoryDiagnosticsRisk;
  warning?: string;
  details?: Record<string, string | number | boolean | null>;
}

export interface MemoryDiagnosticsFrontendSnapshot {
  capturedAt: number;
  webviewHeap: {
    usedBytes: number | null;
    totalBytes: number | null;
    limitBytes: number | null;
    unavailableReason: string | null;
  };
  providers: MemoryDiagnosticsProviderSnapshot[];
}

export interface MemoryDiagnosticsSnapshot {
  capturedAt: number;
  backend: MemoryDiagnosticsBackendSnapshot;
  frontend: MemoryDiagnosticsFrontendSnapshot;
}

type MemoryDiagnosticsProvider = () => MemoryDiagnosticsProviderSnapshot | MemoryDiagnosticsProviderSnapshot[] | null;

const providers = new Map<string, MemoryDiagnosticsProvider>();

interface PerformanceWithMemory extends Performance {
  memory?: {
    usedJSHeapSize?: number;
    totalJSHeapSize?: number;
    jsHeapSizeLimit?: number;
  };
}

export function registerMemoryDiagnosticsProvider(id: string, provider: MemoryDiagnosticsProvider): () => void {
  providers.set(id, provider);
  return () => {
    if (providers.get(id) === provider) {
      providers.delete(id);
    }
  };
}

export function collectMemoryDiagnosticsProviders(): MemoryDiagnosticsProviderSnapshot[] {
  const snapshots: MemoryDiagnosticsProviderSnapshot[] = [];
  for (const [id, provider] of providers) {
    try {
      const value = provider();
      if (!value) continue;
      const items = Array.isArray(value) ? value : [value];
      for (const item of items) {
        snapshots.push({ ...item, id: item.id || id });
      }
    } catch (caught) {
      snapshots.push({
        id,
        label: id,
        category: 'other',
        objectCount: 1,
        estimatedBytes: null,
        risk: 'medium',
        warning: caught instanceof Error ? caught.message : String(caught),
      });
    }
  }
  return snapshots.sort((left, right) => (right.estimatedBytes ?? -1) - (left.estimatedBytes ?? -1));
}

export function readWebviewHeapSnapshot(): MemoryDiagnosticsFrontendSnapshot['webviewHeap'] {
  const memory = (performance as PerformanceWithMemory).memory;
  if (!memory) {
    return {
      usedBytes: null,
      totalBytes: null,
      limitBytes: null,
      unavailableReason: 'performance.memory unavailable in this WebView',
    };
  }

  return {
    usedBytes: memory.usedJSHeapSize ?? null,
    totalBytes: memory.totalJSHeapSize ?? null,
    limitBytes: memory.jsHeapSizeLimit ?? null,
    unavailableReason: null,
  };
}

export function collectFrontendMemoryDiagnostics(): MemoryDiagnosticsFrontendSnapshot {
  return {
    capturedAt: Date.now(),
    webviewHeap: readWebviewHeapSnapshot(),
    providers: collectMemoryDiagnosticsProviders(),
  };
}

export function sanitizeMemoryDiagnosticsForExport(snapshot: MemoryDiagnosticsSnapshot): MemoryDiagnosticsSnapshot {
  return {
    ...snapshot,
    frontend: {
      ...snapshot.frontend,
      providers: snapshot.frontend.providers.map((provider) => ({
        ...provider,
        details: provider.details
          ? Object.fromEntries(
            Object.entries(provider.details).filter(([key]) => !/token|secret|password|key/i.test(key)),
          )
          : undefined,
      })),
    },
  };
}
