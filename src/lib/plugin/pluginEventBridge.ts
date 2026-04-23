// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

/**
 * Plugin Event Bridge
 *
 * A simple pub/sub event bus for plugin system events.
 * Bridges appStore state changes to plugin lifecycle events.
 * All handlers are called via queueMicrotask() to avoid blocking state updates.
 */

import { toSnapshot } from './pluginUtils';
import { useSessionTreeStore } from '../../store/sessionTreeStore';
import { runtimeEventHub } from '../runtimeEventHub';

type EventHandler = (data: unknown) => void;

class PluginEventBridge {
  private handlers = new Map<string, Set<EventHandler>>();

  /**
   * Subscribe to an event. Returns an unsubscribe function.
   */
  on(event: string, handler: EventHandler): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);

    return () => {
      const set = this.handlers.get(event);
      if (set) {
        set.delete(handler);
        if (set.size === 0) this.handlers.delete(event);
      }
    };
  }

  /**
   * Emit an event to all subscribers.
   * Handlers are called asynchronously via queueMicrotask().
   */
  emit(event: string, data: unknown): void {
    const set = this.handlers.get(event);
    if (!set || set.size === 0) return;

    for (const handler of set) {
      queueMicrotask(() => {
        try {
          handler(data);
        } catch (err) {
          console.error(`[PluginEventBridge] Error in handler for "${event}":`, err);
        }
      });
    }
  }

  /**
   * Remove all handlers (used during cleanup).
   */
  clear(): void {
    this.handlers.clear();
  }
}

/** Singleton event bridge instance */
export const pluginEventBridge = new PluginEventBridge();

/**
 * Wire appStore connection state changes → plugin events.
 * Call once at app startup. Returns an unsubscribe function.
 *
 * Accepts the useAppStore reference to avoid `require()` (not available in ESM/Vite).
 */
export function setupConnectionBridge(
  useAppStore: typeof import('../../store/appStore').useAppStore,
): () => void {
  type AppState = ReturnType<typeof useAppStore.getState>;
  type ConnectionsSlice = AppState['connections'];
  const subscribeToConnections = useAppStore.subscribe as unknown as (
    selector: (state: AppState) => ConnectionsSlice,
    listener: (curr: ConnectionsSlice) => void,
  ) => () => void;
  let prevConnections = useAppStore.getState().connections;

  const unsubscribe = subscribeToConnections((state) => state.connections, (curr) => {
    // Detect new, changed, and removed connections
    for (const [id, conn] of curr) {
      const prev = prevConnections.get(id);
      const snapshot = toSnapshot(conn);

      if (!prev) {
        // New connection appeared
        if (conn.state === 'active') {
          pluginEventBridge.emit('connection:connect', snapshot);
        }
      } else if (prev.state !== conn.state) {
        // State transition
        if (conn.state === 'active' && prev.state !== 'active') {
          // Became active — was it a reconnect or a fresh connect?
          const wasReconnecting = prev.state === 'reconnecting' || prev.state === 'link_down' || typeof prev.state === 'object';
          if (wasReconnecting) {
            pluginEventBridge.emit('connection:reconnect', snapshot);
          } else {
            pluginEventBridge.emit('connection:connect', snapshot);
          }
        } else if (conn.state === 'reconnecting' || conn.state === 'link_down' || typeof conn.state === 'object') {
          pluginEventBridge.emit('connection:link_down', snapshot);
        } else if (conn.state === 'idle' && prev.state === 'active') {
          // idle = live SSH connection with no terminals; not a disconnect
          pluginEventBridge.emit('connection:idle', snapshot);
        } else if (conn.state === 'disconnected' || conn.state === 'disconnecting') {
          // Emit disconnect for any prev state (active, link_down, reconnecting, etc.)
          pluginEventBridge.emit('connection:disconnect', snapshot);
        }
      }
    }

    // Detect removed connections
    for (const [id, prev] of prevConnections) {
      if (!curr.has(id)) {
        // Only emit disconnect if we haven't already emitted one for the
        // state transition (e.g. active → disconnected → removed).
        if (prev.state !== 'disconnected' && prev.state !== 'disconnecting') {
          pluginEventBridge.emit('connection:disconnect', toSnapshot(prev));
        }
      }
    }
    prevConnections = curr;
  });

  return unsubscribe;
}

/**
 * Phase 4.5: Wire backend "node:state" Tauri events → plugin node lifecycle events.
 * Emits 'node:ready' and 'node:disconnected' to the plugin event bridge.
 *
 * Generation-based ordering: per-node generation tracking ensures out-of-order
 * events (rare but possible under high load) are dropped before they trigger
 * spurious lifecycle transitions in plugins.
 *
 * Call once at app startup. Returns a cleanup function.
 */
export async function setupNodeStateBridge(): Promise<() => void> {
  // Track per-node readiness to detect transitions
  const nodeReadiness = new Map<string, string>();
  // Track per-node generation to drop out-of-order events
  const nodeGeneration = new Map<string, number>();

  const unlisten = runtimeEventHub.subscribe('nodeState', (payload) => {
    if (payload.type !== 'connectionStateChanged') return;

    const { nodeId, generation, state: newState } = payload;

    // Generation guard: drop stale/out-of-order events
    const prevGen = nodeGeneration.get(nodeId) ?? 0;
    if (generation <= prevGen) {
      console.debug(`[PluginEventBridge] Dropping stale node:state for ${nodeId} (gen ${generation} <= ${prevGen})`);
      return;
    }
    nodeGeneration.set(nodeId, generation);

    const prevState = nodeReadiness.get(nodeId);
    nodeReadiness.set(nodeId, newState);

    // ready transition → emit node:ready
    if (newState === 'ready' && prevState !== 'ready') {
      const node = useSessionTreeStore.getState().getNode(nodeId);
      const connectionId = node?.runtime.connectionId ?? '';
      pluginEventBridge.emit('node:ready', { nodeId, connectionId });
    }

    // disconnected/error → emit node:disconnected, then clean up tracking Maps
    if ((newState === 'disconnected' || newState === 'error') && prevState === 'ready') {
      pluginEventBridge.emit('node:disconnected', { nodeId });
    }

    // 节点进入终态时清理跟踪条目，防止 Map 在节点 churn 下单调增长
    if (newState === 'disconnected' || newState === 'error') {
      nodeReadiness.delete(nodeId);
      nodeGeneration.delete(nodeId);
    }
  });

  // Subscribe to sessionTreeStore to clean up when nodes are removed from tree
  const unsubTree = useSessionTreeStore.subscribe(
    (state) => state.nodes,
    (nodes) => {
      // Build set of current node IDs
      const currentIds = new Set(nodes.map(n => n.id));
      // Evict stale entries from tracking Maps
      for (const id of nodeReadiness.keys()) {
        if (!currentIds.has(id)) {
          nodeReadiness.delete(id);
          nodeGeneration.delete(id);
        }
      }
    },
  );

  return () => {
    unlisten();
    unsubTree();
    nodeReadiness.clear();
    nodeGeneration.clear();
  };
}

/**
 * v3: Wire transfer completion events → plugin events.
 * Emits 'transfer:complete' and 'transfer:error'.
 * Call once at app startup. Returns a cleanup function.
 */
export function setupTransferBridge(): () => void {
  let unsub: (() => void) | null = null;
  let prevStates = new Map<string, string>();

  void import('../../store/transferStore').then(({ useTransferStore }) => {
    type TransferState = ReturnType<typeof useTransferStore.getState>;
    type TransferSlice = TransferState['transfers'];
    const subscribeToTransfers = useTransferStore.subscribe as unknown as (
      selector: (state: TransferState) => TransferSlice,
      listener: (transfers: TransferSlice) => void,
    ) => () => void;
    for (const [id, transfer] of useTransferStore.getState().transfers) {
      prevStates.set(id, transfer.state);
    }
    unsub = subscribeToTransfers((state) => state.transfers, (transfers) => {
      for (const [id, t] of transfers) {
        const prev = prevStates.get(id);
        if (t.state === 'completed' && prev !== 'completed') {
          pluginEventBridge.emit('transfer:complete', { id: t.id, nodeId: t.nodeId, name: t.name, direction: t.direction });
        } else if (t.state === 'error' && prev !== 'error') {
          pluginEventBridge.emit('transfer:error', { id: t.id, nodeId: t.nodeId, name: t.name, error: t.error });
        }
        prevStates.set(id, t.state);
      }

      for (const id of Array.from(prevStates.keys())) {
        if (!transfers.has(id)) {
          prevStates.delete(id);
        }
      }
    });
  }).catch((err) => {
    console.error('[PluginEventBridge] Failed to setup transfer bridge:', err);
  });

  return () => { unsub?.(); };
}
