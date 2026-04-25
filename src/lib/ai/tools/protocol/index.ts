// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

export type {
  ToolCapability,
  ToolResultEnvelope,
  ToolResultError,
  ToolResultMeta,
  ToolRisk,
  ToolTarget,
  ToolTargetKind,
} from './types';
export {
  createToolResultEnvelope,
  fromLegacyToolResult,
  toLegacyToolResult,
} from './envelope';
export { inferToolRisk } from './risk';
export { createToolTarget, hasTargetCapability } from './targets';
