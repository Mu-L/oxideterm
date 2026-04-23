// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

/**
 * Forward Events Hook
 *
 * Listens to forward status change events from Rust backend.
 * Used to receive "death reports" when forwards exit due to SSH disconnect.
 */

import { useEffect, useCallback } from 'react';
import { runtimeEventHub, type ForwardRuntimeEvent } from '../lib/runtimeEventHub';

/**
 * Forward status from backend
 */
export type ForwardStatus = 'starting' | 'active' | 'stopped' | 'error' | 'suspended';

/**
 * Forward event types emitted from backend
 */
export type ForwardEvent = ForwardRuntimeEvent;

export interface UseForwardEventsOptions {
  /**
   * Whether the listener should be active.
   * Use this to avoid subscribing before a node has a resolved terminal session.
   */
  enabled?: boolean;
  /**
   * Session ID to filter events for (only events for this session will be handled).
   * If not provided, all events will be handled (useful for node-first components).
   */
  sessionId?: string;
  /**
   * Callback when a forward's status changes
   */
  onStatusChanged?: (forwardId: string, status: ForwardStatus, error?: string) => void;
  /**
   * Callback when forward stats are updated
   */
  onStatsUpdated?: (forwardId: string, stats: NonNullable<ForwardEvent['stats']>) => void;
  /**
   * Callback when all forwards for a session are suspended (SSH disconnect)
   */
  onSessionSuspended?: (forwardIds: string[]) => void;
}

/**
 * Hook to listen for forward events from the Rust backend.
 *
 * @example
 * ```tsx
 * useForwardEvents({
 *   sessionId,
 *   onStatusChanged: (forwardId, status, error) => {
 *     console.log(`Forward ${forwardId} changed to ${status}`);
 *     if (status === 'suspended') {
 *       // SSH disconnected, forward is paused
 *       refreshForwards();
 *     }
 *   },
 *   onSessionSuspended: (forwardIds) => {
 *     console.log('All forwards suspended:', forwardIds);
 *   }
 * });
 * ```
 */
export function useForwardEvents({
  enabled = true,
  sessionId,
  onStatusChanged,
  onStatsUpdated,
  onSessionSuspended,
}: UseForwardEventsOptions): void {
  const handleEvent = useCallback(
    (event: ForwardEvent) => {
      // Filter by session ID if provided
      if (sessionId && event.session_id !== sessionId) {
        return;
      }

      switch (event.type) {
        case 'statusChanged':
          if (event.forward_id && event.status && onStatusChanged) {
            onStatusChanged(event.forward_id, event.status, event.error);
          }
          break;

        case 'statsUpdated':
          if (event.forward_id && event.stats && onStatsUpdated) {
            onStatsUpdated(event.forward_id, event.stats);
          }
          break;

        case 'sessionSuspended':
          if (event.forward_ids && onSessionSuspended) {
            onSessionSuspended(event.forward_ids);
          }
          break;
      }
    },
    [sessionId, onStatusChanged, onStatsUpdated, onSessionSuspended]
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const unsubscribe = runtimeEventHub.subscribe('forwardEvent', handleEvent);

    return () => {
      unsubscribe();
    };
  }, [enabled, handleEvent]);
}
