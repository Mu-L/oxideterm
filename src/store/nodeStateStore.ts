// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { nodeGetState } from '../lib/api';
import { runtimeEventHub } from '../lib/runtimeEventHub';
import { useSessionTreeStore } from './sessionTreeStore';
import type { NodeState, NodeStateEvent, NodeStateSnapshot, NodeReadiness } from '../types';

export interface NodeStateEntry {
  snapshot: NodeStateSnapshot;
  ready: boolean;
}

const INITIAL_STATE: NodeState = {
  readiness: 'disconnected',
  sftpReady: false,
};

const INITIAL_ENTRY: NodeStateEntry = {
  snapshot: {
    state: INITIAL_STATE,
    generation: 0,
  },
  ready: false,
};

interface NodeStateStore {
  entries: Map<string, NodeStateEntry>;
  pendingLoads: Map<string, Promise<void>>;
  applySnapshot: (nodeId: string, snapshot: NodeStateSnapshot) => void;
  applyEvent: (event: NodeStateEvent) => void;
  ensureNode: (nodeId: string) => Promise<void>;
  syncTrackedNodes: (nodeIds: readonly string[]) => void;
  resetNode: (nodeId: string) => void;
  getEntry: (nodeId: string) => NodeStateEntry;
}

export const useNodeStateStore = create<NodeStateStore>()(
  subscribeWithSelector((set, get) => ({
    entries: new Map(),
    pendingLoads: new Map(),

    applySnapshot: (nodeId, snapshot) => {
      set((state) => {
        const prev = state.entries.get(nodeId);
        if (prev && snapshot.generation < prev.snapshot.generation) {
          return state;
        }

        const entries = new Map(state.entries);
        entries.set(nodeId, {
          snapshot,
          ready: true,
        });
        return { entries };
      });
    },

    applyEvent: (event) => {
      set((state) => {
        const current = state.entries.get(event.nodeId) ?? INITIAL_ENTRY;
        if (event.generation <= current.snapshot.generation) {
          return state;
        }

        const nextState: NodeState = { ...current.snapshot.state };
        switch (event.type) {
          case 'connectionStateChanged':
            nextState.readiness = event.state as NodeReadiness;
            nextState.error = event.state === 'error' ? event.reason : undefined;
            break;
          case 'sftpReady':
            nextState.sftpReady = event.ready;
            nextState.sftpCwd = event.cwd;
            break;
          case 'terminalEndpointChanged':
            nextState.wsEndpoint = {
              wsPort: event.wsPort,
              wsToken: event.wsToken,
              sessionId: current.snapshot.state.wsEndpoint?.sessionId ?? '',
            };
            break;
        }

        const entries = new Map(state.entries);
        entries.set(event.nodeId, {
          snapshot: {
            state: nextState,
            generation: event.generation,
          },
          ready: true,
        });
        return { entries };
      });
    },

    ensureNode: async (nodeId) => {
      const existing = get().entries.get(nodeId);
      if (existing?.ready) return;

      const pending = get().pendingLoads.get(nodeId);
      if (pending) return pending;

      const loadPromise = nodeGetState(nodeId)
        .then((snapshot) => {
          get().applySnapshot(nodeId, snapshot);
        })
        .catch((error) => {
          console.warn(`[NodeStateStore] Failed to load node snapshot for ${nodeId}:`, error);
          set((state) => {
            const entries = new Map(state.entries);
            entries.set(nodeId, {
              snapshot: {
                state: INITIAL_STATE,
                generation: 0,
              },
              ready: true,
            });
            return { entries };
          });
        })
        .finally(() => {
          set((state) => {
            const pendingLoads = new Map(state.pendingLoads);
            pendingLoads.delete(nodeId);
            return { pendingLoads };
          });
        });

      set((state) => {
        const pendingLoads = new Map(state.pendingLoads);
        pendingLoads.set(nodeId, loadPromise);
        return { pendingLoads };
      });

      return loadPromise;
    },

    syncTrackedNodes: (nodeIds) => {
      const trackedIds = new Set(nodeIds);

      set((state) => {
        let changed = false;
        const entries = new Map(state.entries);
        const pendingLoads = new Map(state.pendingLoads);

        for (const nodeId of entries.keys()) {
          if (!trackedIds.has(nodeId)) {
            entries.delete(nodeId);
            pendingLoads.delete(nodeId);
            changed = true;
          }
        }

        return changed ? { entries, pendingLoads } : state;
      });

      for (const nodeId of trackedIds) {
        void get().ensureNode(nodeId);
      }
    },

    resetNode: (nodeId) => {
      set((state) => {
        const entries = new Map(state.entries);
        entries.set(nodeId, INITIAL_ENTRY);
        const pendingLoads = new Map(state.pendingLoads);
        pendingLoads.delete(nodeId);
        return { entries, pendingLoads };
      });
    },

    getEntry: (nodeId) => get().entries.get(nodeId) ?? INITIAL_ENTRY,
  })),
);

let nodeStateBridgeRefCount = 0;
let nodeStateBridgeCleanup: (() => void) | null = null;
let nodeStateTreeCleanup: (() => void) | null = null;

export function retainNodeStateBridge(): () => void {
  nodeStateBridgeRefCount += 1;
  if (nodeStateBridgeRefCount === 1) {
    nodeStateBridgeCleanup = runtimeEventHub.subscribe('nodeState', (event) => {
      useNodeStateStore.getState().applyEvent(event);
    });
    nodeStateTreeCleanup = useSessionTreeStore.subscribe(
      (state) => state.nodes.map((node) => node.id),
      (nodeIds) => {
        useNodeStateStore.getState().syncTrackedNodes(nodeIds);
      },
    );
    useNodeStateStore.getState().syncTrackedNodes(
      useSessionTreeStore.getState().nodes.map((node) => node.id),
    );
  }

  return () => {
    nodeStateBridgeRefCount = Math.max(0, nodeStateBridgeRefCount - 1);
    if (nodeStateBridgeRefCount === 0) {
      nodeStateBridgeCleanup?.();
      nodeStateTreeCleanup?.();
      nodeStateBridgeCleanup = null;
      nodeStateTreeCleanup = null;
    }
  };
}

export function resetNodeStateStoreForTests(): void {
  nodeStateBridgeCleanup?.();
  nodeStateTreeCleanup?.();
  nodeStateBridgeCleanup = null;
  nodeStateTreeCleanup = null;
  nodeStateBridgeRefCount = 0;
  useNodeStateStore.setState({
    entries: new Map(),
    pendingLoads: new Map(),
  });
}
