// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { NodeStateEvent, ResourceMetrics } from '../types';

export interface ConnectionStatusEvent {
  connection_id: string;
  status: 'connected' | 'link_down' | 'reconnecting' | 'disconnected';
  affected_children: string[];
  timestamp: number;
}

export interface EnvDetectedEvent {
  connectionId: string;
  osType: string;
  osVersion?: string;
  kernel?: string;
  arch?: string;
  shell?: string;
  detectedAt: number;
}

export interface ForwardRuntimeEvent {
  type: 'statusChanged' | 'statsUpdated' | 'sessionSuspended';
  forward_id?: string;
  session_id: string;
  status?: 'starting' | 'active' | 'stopped' | 'error' | 'suspended';
  error?: string;
  stats?: {
    connection_count: number;
    active_connections: number;
    bytes_sent: number;
    bytes_received: number;
  };
  forward_ids?: string[];
}

export interface ProfilerUpdateEvent {
  connectionId: string;
  metrics: ResourceMetrics;
}

type RuntimeEventMap = {
  connectionStatusChanged: ConnectionStatusEvent;
  envDetected: EnvDetectedEvent;
  nodeState: NodeStateEvent;
  forwardEvent: ForwardRuntimeEvent;
  profilerUpdate: ProfilerUpdateEvent;
};

type EventKey = keyof RuntimeEventMap;
type RuntimeEventHandler<K extends EventKey> = (payload: RuntimeEventMap[K]) => void;

class RuntimeEventHub {
  private handlers = new Map<EventKey, Set<(payload: unknown) => void>>();
  private unlisteners: UnlistenFn[] = [];
  private startPromise: Promise<void> | null = null;
  private active = false;

  initialize(): Promise<void> {
    return this.ensureStarted();
  }

  subscribe<K extends EventKey>(event: K, handler: RuntimeEventHandler<K>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as (payload: unknown) => void);
    void this.ensureStarted();

    return () => {
      const current = this.handlers.get(event);
      if (current) {
        current.delete(handler as (payload: unknown) => void);
        if (current.size === 0) {
          this.handlers.delete(event);
        }
      }
      if (this.totalHandlerCount() === 0) {
        void this.teardown();
      }
    };
  }

  private emit<K extends EventKey>(event: K, payload: RuntimeEventMap[K]): void {
    const set = this.handlers.get(event);
    if (!set || set.size === 0) return;

    for (const handler of set) {
      try {
        handler(payload);
      } catch (error) {
        console.error(`[RuntimeEventHub] handler for ${event} failed:`, error);
      }
    }
  }

  private totalHandlerCount(): number {
    let count = 0;
    for (const set of this.handlers.values()) count += set.size;
    return count;
  }

  private async ensureStarted(): Promise<void> {
    if (this.active) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = (async () => {
      const unlisteners = await Promise.all([
        listen<ConnectionStatusEvent>('connection_status_changed', (event) => {
          this.emit('connectionStatusChanged', event.payload);
        }),
        listen<EnvDetectedEvent>('env:detected', (event) => {
          this.emit('envDetected', event.payload);
        }),
        listen<NodeStateEvent>('node:state', (event) => {
          this.emit('nodeState', event.payload);
        }),
        listen<ForwardRuntimeEvent>('forward-event', (event) => {
          this.emit('forwardEvent', event.payload);
        }),
        listen<ProfilerUpdateEvent>('profiler:update', (event) => {
          this.emit('profilerUpdate', event.payload);
        }),
      ]);

      this.unlisteners = unlisteners;
      this.active = true;
    })()
      .catch((error) => {
        console.error('[RuntimeEventHub] Failed to initialize runtime listeners:', error);
        throw error;
      })
      .finally(() => {
        this.startPromise = null;
      });

    await this.startPromise;

    if (this.totalHandlerCount() === 0) {
      await this.teardown();
    }
  }

  private async teardown(): Promise<void> {
    if (this.startPromise) {
      await this.startPromise.catch(() => undefined);
    }
    if (!this.active) return;

    for (const unlisten of this.unlisteners) {
      try {
        unlisten();
      } catch (error) {
        console.error('[RuntimeEventHub] Failed to unlisten runtime event:', error);
      }
    }
    this.unlisteners = [];
    this.active = false;
  }

  async resetForTests(): Promise<void> {
    this.handlers.clear();
    await this.teardown();
    this.startPromise = null;
  }
}

export const runtimeEventHub = new RuntimeEventHub();

export function initializeRuntimeEventHub(): Promise<void> {
  return runtimeEventHub.initialize();
}

export function resetRuntimeEventHubForTests(): Promise<void> {
  return runtimeEventHub.resetForTests();
}
