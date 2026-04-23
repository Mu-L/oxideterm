// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

/**
 * Hook to listen for SSH connection status change events from backend
 *
 * 重连逻辑已委托给 reconnectOrchestratorStore。
 * 本 hook 仅负责：
 *   1. 监听 connection_status_changed 事件并更新 store
 *   2. link_down → 委托给 orchestrator.scheduleReconnect
 *   3. connected → 清除 link-down 标记
 *   4. disconnected → 关闭相关 tabs
 *   5. env:detected → 更新远程环境信息
 */

import { useEffect, useRef } from 'react';
import { removeConnectionsById, tabReferencesAnySession, useAppStore } from '../store/appStore';
import { useTransferStore } from '../store/transferStore';
import { useSessionTreeStore } from '../store/sessionTreeStore';
import { useReconnectOrchestratorStore } from '../store/reconnectOrchestratorStore';
import { useProfilerStore } from '../store/profilerStore';
import { topologyResolver } from '../lib/topologyResolver';
import { slog } from '../lib/structuredLog';
import { resolveConnectionNotifications } from '../lib/notificationCenter';
import { runtimeEventHub } from '../lib/runtimeEventHub';
import i18n from '../i18n';
import type { SshConnectionState } from '../types';

// ═══════════════════════════════════════════════════════════════════════════════
// 主 Hook
// ═══════════════════════════════════════════════════════════════════════════════

export function useConnectionEvents(): void {
  // Use selectors to get stable function references
  const updateConnectionState = useAppStore((state) => state.updateConnectionState);
  const updateConnectionRemoteEnv = useAppStore((state) => state.updateConnectionRemoteEnv);
  const interruptTransfersByNode = useTransferStore((state) => state.interruptTransfersByNode);
  
  // Use ref for sessions to avoid re-subscribing on every session change
  const sessionsRef = useRef(useAppStore.getState().sessions);
  
  // Keep sessionsRef in sync without triggering re-renders
  useEffect(() => {
    const unsubscribe = useAppStore.subscribe(
      (state) => { sessionsRef.current = state.sessions; }
    );
    return unsubscribe;
  }, []);

  useEffect(() => {
    // 获取 store 方法（避免闭包问题）
    const getTreeStore = () => useSessionTreeStore.getState();
    const getOrchestrator = () => useReconnectOrchestratorStore.getState();

    const unlistenStatus = runtimeEventHub.subscribe('connectionStatusChanged', (payload) => {
          const { connection_id, status, affected_children } = payload;
          const affectedChildren = Array.isArray(affected_children) ? affected_children : [];
          console.log(`[ConnectionEvents] ${connection_id} -> ${status}`, { affected_children: affectedChildren });

          // Structured log for diagnostics
          slog({
            component: 'ConnectionEvents',
            event: 'status_changed',
            connectionId: connection_id,
            detail: status,
            nodeId: topologyResolver.getNodeId(connection_id) ?? undefined,
          });

          // Map backend status to frontend state
          let state: SshConnectionState;
          switch (status) {
            case 'connected':
              state = 'active';
              break;
            case 'link_down':
              state = 'link_down';
              break;
            case 'reconnecting':
              // 🛑 后端不再发送 reconnecting 状态（重连引擎已删除）
              // 保留此分支以兼容可能的遗留事件
              state = 'reconnecting';
              break;
            case 'disconnected':
              state = 'disconnected';
              break;
            default:
              console.warn(`[ConnectionEvents] Unknown status: ${status}`);
              return;
          }

          updateConnectionState(connection_id, state);

          // ========== link_down 处理：委托给 Orchestrator ==========
          if (status === 'link_down') {
            console.log(`[ConnectionEvents] 🔴 LINK_DOWN received for connection ${connection_id}`);
            
            // 1. 标记受影响的节点
            const affectedNodeIds = topologyResolver.handleLinkDown(connection_id, affectedChildren);

            slog({
              component: 'ConnectionEvents',
              event: 'link_down',
              connectionId: connection_id,
              nodeId: topologyResolver.getNodeId(connection_id) ?? undefined,
              outcome: 'ok',
              detail: `affected=${affectedNodeIds.length} children=${affectedChildren.length}`,
            });

            if (affectedNodeIds.length > 0) {
              getTreeStore().markLinkDownBatch(affectedNodeIds);
            }
            
            // 2. 委托给 orchestrator 调度重连
            const nodeId = topologyResolver.getNodeId(connection_id);
            if (nodeId) {
              getOrchestrator().scheduleReconnect(nodeId);
            } else {
              console.error(`[ConnectionEvents] ❌ Cannot schedule reconnect: no nodeId found for connection ${connection_id}`);
            }
            
            // 3. 中断 SFTP 传输
            if (nodeId) {
              interruptTransfersByNode(nodeId, i18n.t('connections.events.connection_lost_reconnecting'));
            }
          }

          // ========== connected 处理：清除 link-down 标记 + 自动消解通知 ==========
          if (status === 'connected') {
            const nodeId = topologyResolver.getNodeId(connection_id);
            if (nodeId) {
              getTreeStore().clearLinkDown(nodeId);
              getTreeStore().setReconnectProgress(nodeId, null);
              // Auto-resolve: dismiss stale connection error notifications for this node
              resolveConnectionNotifications(nodeId);
            }
          }
          
          // ========== disconnected 处理：关闭相关 tabs ==========
          if (status === 'disconnected') {
            const sessions = sessionsRef.current;
            const appStore = useAppStore.getState();
            const disconnectedConnectionIds = new Set([connection_id, ...affectedChildren]);
            const sessionIdsToClose: string[] = [];
            const disconnectedNodeIds = new Set<string>();

            for (const disconnectedConnectionId of disconnectedConnectionIds) {
              const nodeId = topologyResolver.getNodeId(disconnectedConnectionId);
              if (nodeId) {
                disconnectedNodeIds.add(nodeId);
              }
            }
            
            sessions.forEach((session, sessionId) => {
              if (session.connectionId && disconnectedConnectionIds.has(session.connectionId)) {
                sessionIdsToClose.push(sessionId);
              }
            });

            const sessionIdSet = new Set(sessionIdsToClose);
            const tabsToClose = appStore.tabs.filter((tab) =>
              tabReferencesAnySession(tab, sessionIdSet) ||
              (!!tab.nodeId && disconnectedNodeIds.has(tab.nodeId))
            );
            for (const tab of tabsToClose) {
              appStore.closeTab(tab.id);
            }
            
            // 中断 SFTP 传输
            for (const disconnectedNodeId of disconnectedNodeIds) {
              interruptTransfersByNode(disconnectedNodeId, i18n.t('connections.events.connection_closed'));
              topologyResolver.unregister(disconnectedNodeId);
            }
            
            useAppStore.setState((state) => ({
              connections: removeConnectionsById(state.connections, disconnectedConnectionIds),
            }));
            
            // 清理 profiler 事件监听器（避免断开后残留 Tauri 事件订阅）
            for (const disconnectedConnectionId of disconnectedConnectionIds) {
              useProfilerStore.getState().removeConnection(disconnectedConnectionId);
            }
          }
        });

    const unlistenEnvDetected = runtimeEventHub.subscribe('envDetected', (payload) => {
          const { connectionId, osType, osVersion, kernel, arch, shell, detectedAt } = payload;
          console.log(`[ConnectionEvents] env:detected for ${connectionId}: ${osType}`);
          
          updateConnectionRemoteEnv(connectionId, {
            osType,
            osVersion,
            kernel,
            arch,
            shell,
            detectedAt,
          });
        });

    // Cleanup function with proper async handling
    return () => {
      unlistenStatus();
      unlistenEnvDetected();
    };
  // Dependencies are stable: updateConnectionState, updateConnectionRemoteEnv, and interruptTransfersByNode are selectors
  // sessionsRef is updated via subscription, not as a dependency
  }, [updateConnectionState, updateConnectionRemoteEnv, interruptTransfersByNode]);
}
