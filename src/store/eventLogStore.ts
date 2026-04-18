// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

/**
 * Event Log Store
 *
 * Aggregates connection lifecycle and reconnect pipeline events
 * into a unified, filterable log panel — similar to VS Code's Problems panel.
 *
 * In-memory only; cleared on app restart.
 * Ring buffer capped at MAX_ENTRIES to bound memory usage.
 */

import { create } from 'zustand';

// ============================================================================
// Constants
// ============================================================================

const MAX_ENTRIES = 500;

// ============================================================================
// Types
// ============================================================================

export type EventSeverity = 'info' | 'warn' | 'error';

export type EventCategory = 'connection' | 'reconnect' | 'node';

export type EventLogEntry = {
  /** Monotonically increasing ID */
  id: number;
  /** Unix timestamp in milliseconds */
  timestamp: number;
  /** Severity level */
  severity: EventSeverity;
  /** Event category */
  category: EventCategory;
  /** Associated node ID (if any) */
  nodeId?: string;
  /** Associated connection ID (if any) */
  connectionId?: string;
  /** Human-readable event title (i18n key or resolved string) */
  title: string;
  /** Optional detail message */
  detail?: string;
  /** Source identifier (e.g. 'connection_status_changed', 'reconnect_orchestrator') */
  source: string;
};

export type EventFilter = {
  severity: EventSeverity | 'all';
  category: EventCategory | 'all';
  search: string;
};

interface EventLogState {
  /** All log entries (most recent last) */
  entries: EventLogEntry[];
  /** Whether the bottom panel is visible */
  isOpen: boolean;
  /** Persisted panel size (percentage, 0-100) */
  panelSize: number;
  /** Active filter */
  filter: EventFilter;
  /** Suppress unread badges while still retaining entries */
  dndEnabled: boolean;
  /** Monotonic counter for entry IDs */
  _nextId: number;
  /** Number of unread entries since panel was last opened/focused */
  unreadCount: number;
  /** Number of unread errors */
  unreadErrors: number;

  // Actions
  addEntry: (entry: Omit<EventLogEntry, 'id' | 'timestamp'>) => void;
  clear: () => void;
  togglePanel: () => void;
  openPanel: () => void;
  closePanel: () => void;
  setPanelSize: (size: number) => void;
  setFilter: (filter: Partial<EventFilter>) => void;
  markRead: () => void;
  setDndEnabled: (enabled: boolean) => void;
  toggleDnd: () => void;
}

// ============================================================================
// Store
// ============================================================================

export const useEventLogStore = create<EventLogState>((set) => ({
  entries: [],
  isOpen: false,
  panelSize: 25,
  filter: { severity: 'all', category: 'all', search: '' },
  dndEnabled: true,
  _nextId: 1,
  unreadCount: 0,
  unreadErrors: 0,

  addEntry: (partial) => set((state) => {
    const entry: EventLogEntry = {
      ...partial,
      id: state._nextId,
      timestamp: Date.now(),
    };
    const newEntries = [...state.entries, entry];
    // Ring buffer: keep only the last MAX_ENTRIES
    if (newEntries.length > MAX_ENTRIES) {
      newEntries.splice(0, newEntries.length - MAX_ENTRIES);
    }
    return {
      entries: newEntries,
      _nextId: state._nextId + 1,
      unreadCount: state.isOpen ? state.unreadCount : state.unreadCount + 1,
      unreadErrors: partial.severity === 'error' && !state.isOpen
        ? state.unreadErrors + 1
        : state.unreadErrors,
    };
  }),

  clear: () => set({ entries: [], unreadCount: 0, unreadErrors: 0 }),

  togglePanel: () => set((state) => {
    const opening = !state.isOpen;
    return {
      isOpen: opening,
      unreadCount: opening ? 0 : state.unreadCount,
      unreadErrors: opening ? 0 : state.unreadErrors,
      // Reset filter when opening to avoid confusion with hidden entries
      ...(opening ? { filter: { severity: 'all' as const, category: 'all' as const, search: '' } } : {}),
    };
  }),

  openPanel: () => set({ isOpen: true, unreadCount: 0, unreadErrors: 0, filter: { severity: 'all', category: 'all', search: '' } }),

  closePanel: () => set({ isOpen: false }),

  setPanelSize: (size) => set({ panelSize: size }),

  setFilter: (partial) => set((state) => ({
    filter: { ...state.filter, ...partial },
  })),

  markRead: () => set({ unreadCount: 0, unreadErrors: 0 }),

  setDndEnabled: (enabled) => set((state) => {
    if (state.dndEnabled === enabled) {
      return state;
    }

    return { dndEnabled: enabled };
  }),

  toggleDnd: () => set((state) => ({
    dndEnabled: !state.dndEnabled,
  })),
}));
