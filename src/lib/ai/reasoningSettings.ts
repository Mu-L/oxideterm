// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import type { AiReasoningEffort } from './providers';

type ReasoningSettings = {
  reasoningEffort?: AiReasoningEffort;
  reasoningProviderOverrides?: Record<string, AiReasoningEffort>;
  reasoningModelOverrides?: Record<string, Record<string, AiReasoningEffort>>;
};

/**
 * Resolve reasoning effort with the same priority users see in settings:
 * model override > provider override > global default.
 */
export function resolveAiReasoningEffort(
  settings: ReasoningSettings,
  providerId: string | null | undefined,
  modelId: string | null | undefined,
): AiReasoningEffort {
  if (providerId && modelId) {
    const modelOverride = settings.reasoningModelOverrides?.[providerId]?.[modelId];
    if (modelOverride) return modelOverride;
  }
  if (providerId) {
    const providerOverride = settings.reasoningProviderOverrides?.[providerId];
    if (providerOverride) return providerOverride;
  }
  return settings.reasoningEffort ?? 'auto';
}
