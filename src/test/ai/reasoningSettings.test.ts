import { describe, expect, it } from 'vitest';
import { resolveAiReasoningEffort } from '@/lib/ai/reasoningSettings';

describe('resolveAiReasoningEffort', () => {
  it('uses model override before provider override before global default', () => {
    const settings = {
      reasoningEffort: 'off' as const,
      reasoningProviderOverrides: { 'provider-1': 'high' as const },
      reasoningModelOverrides: { 'provider-1': { 'model-a': 'max' as const } },
    };

    expect(resolveAiReasoningEffort(settings, 'provider-1', 'model-a')).toBe('max');
    expect(resolveAiReasoningEffort(settings, 'provider-1', 'model-b')).toBe('high');
    expect(resolveAiReasoningEffort(settings, 'provider-2', 'model-a')).toBe('off');
  });
});
