// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import type { ToolCapability, ToolTarget, ToolTargetKind } from './types';

export function createToolTarget(input: {
  id: string;
  kind: ToolTargetKind;
  label: string;
  active?: boolean;
  nodeId?: string;
  sessionId?: string;
  tabId?: string;
  capabilities?: ToolCapability[];
  metadata?: Record<string, unknown>;
}): ToolTarget {
  return {
    id: input.id,
    kind: input.kind,
    label: input.label,
    ...(input.active !== undefined ? { active: input.active } : {}),
    ...(input.nodeId ? { nodeId: input.nodeId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.tabId ? { tabId: input.tabId } : {}),
    capabilities: input.capabilities ?? [],
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}

export function hasTargetCapability(target: ToolTarget, capability: ToolCapability): boolean {
  return target.capabilities.includes(capability);
}
