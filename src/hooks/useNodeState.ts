// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

/**
 * useNodeState — 订阅单个节点的实时状态 (Oxide-Next Phase 3)
 *
 * 设计目标：
 *   - 应用级 bridge 统一接收 "node:state" Tauri 事件并写入全局缓存
 *   - 节点快照由全局同步器按树节点集合惰性拉取
 *   - hook 只负责读取 store，不再自行监听 Tauri 事件或拉取快照
 *
 * 参考: docs/reference/OXIDE_NEXT_ARCHITECTURE.md §4.2
 */

import { useNodeStateStore } from '../store/nodeStateStore';
import type { NodeState } from '../types';

/** useNodeState 返回值 */
export type UseNodeStateResult = {
  /** 节点完整状态 */
  state: NodeState;
  /** 当前 generation（单调递增） */
  generation: number;
  /** 初始快照是否已加载 */
  ready: boolean;
};

/** 默认初始状态 */
const INITIAL_STATE: NodeState = {
  readiness: 'disconnected',
  sftpReady: false,
};

/**
 * 订阅指定节点的实时状态。
 *
 * @param nodeId 节点 ID（来自 SessionTree）
 * @returns 节点状态、generation、加载就绪标志
 *
 * @example
 * ```tsx
 * function TerminalView({ nodeId }: { nodeId: string }) {
 *   const { state, ready } = useNodeState(nodeId);
 *   if (!ready) return <Loading />;
 *   if (state.readiness === 'error') return <ErrorView error={state.error} />;
 *   // ...
 * }
 * ```
 */
export function useNodeState(nodeId: string | undefined): UseNodeStateResult {
  const state = useNodeStateStore((store) =>
    nodeId ? store.getEntry(nodeId).snapshot.state : INITIAL_STATE,
  );
  const generation = useNodeStateStore((store) =>
    nodeId ? store.getEntry(nodeId).snapshot.generation : 0,
  );
  const ready = useNodeStateStore((store) =>
    nodeId ? store.getEntry(nodeId).ready : false,
  );

  return { state, generation, ready };
}
