/**
 * Ollama Provider Adapter
 *
 * Supports local Ollama instances.
 * Uses the OpenAI-compatible `/v1/chat/completions` endpoint (Ollama >= 0.1.14).
 */

import type { AiStreamProvider, AiRequestConfig, ChatMessage, AiStreamEvent, AiToolDefinition } from '../providers';
import { getModelContextWindow } from '../tokenUtils';

/** Timeout for individual /api/show calls (ms) */
const OLLAMA_SHOW_TIMEOUT = 2000;
/** Max "wild" models to query via API (those not in the static lookup table) */
const MAX_WILD_MODELS_QUERY = 20;

/**
 * Convert AiToolDefinition[] to OpenAI function calling format (shared with Ollama).
 */
function convertTools(tools: AiToolDefinition[]): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export const ollamaProvider: AiStreamProvider = {
  type: 'ollama',
  displayName: 'Ollama (Local)',

  async *streamCompletion(
    config: AiRequestConfig,
    messages: ChatMessage[],
    signal: AbortSignal
  ): AsyncGenerator<AiStreamEvent> {
    const cleanBaseUrl = config.baseUrl.replace(/\/+$/, '');
    // Use Ollama's OpenAI-compatible endpoint
    const url = `${cleanBaseUrl}/v1/chat/completions`;

    let response: Response;
    try {
      const body: Record<string, unknown> = {
        model: config.model,
        messages,
        stream: true,
        ...(config.maxResponseTokens ? { max_tokens: config.maxResponseTokens } : {}),
      };
      if (config.tools && config.tools.length > 0) {
        body.tools = convertTools(config.tools);
      }

      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey ? { 'Authorization': `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      yield { type: 'error', message: 'Cannot connect to Ollama. Make sure Ollama is running (ollama serve).' };
      return;
    }

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `Ollama error: ${response.status}`;

      // Special handling for connection refused (Ollama not running)
      if (response.status === 0 || errorText.includes('ECONNREFUSED')) {
        errorMessage = 'Cannot connect to Ollama. Make sure Ollama is running (ollama serve).';
      } else {
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.error?.message || errorJson.error || errorMessage;
        } catch {
          if (errorText) errorMessage = errorText.slice(0, 200);
        }
      }

      yield { type: 'error', message: errorMessage };
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      yield { type: 'error', message: 'No response body' };
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    const pendingToolCalls = new Map<number, { id: string; name: string; arguments: string }>();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') {
              for (const tc of pendingToolCalls.values()) {
                yield { type: 'tool_call_complete', id: tc.id, name: tc.name, arguments: tc.arguments };
              }
              pendingToolCalls.clear();
              yield { type: 'done' };
              return;
            }

            try {
              const json = JSON.parse(data);
              const delta = json.choices?.[0]?.delta;
              const finishReason = json.choices?.[0]?.finish_reason;

              if (delta?.reasoning_content) {
                yield { type: 'thinking', content: delta.reasoning_content };
              }
              // Handle tool_calls delta (OpenAI-compatible format)
              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  if (!pendingToolCalls.has(idx)) {
                    pendingToolCalls.set(idx, { id: tc.id || '', name: tc.function?.name || '', arguments: '' });
                  }
                  const pending = pendingToolCalls.get(idx)!;
                  if (tc.id) pending.id = tc.id;
                  if (tc.function?.name) pending.name = tc.function.name;
                  if (tc.function?.arguments) {
                    pending.arguments += tc.function.arguments;
                    yield { type: 'tool_call', id: pending.id, name: pending.name, arguments: pending.arguments };
                  }
                }
              }
              if (finishReason === 'tool_calls') {
                for (const tc of pendingToolCalls.values()) {
                  yield { type: 'tool_call_complete', id: tc.id, name: tc.name, arguments: tc.arguments };
                }
                pendingToolCalls.clear();
              }
              if (delta?.content) {
                yield { type: 'content', content: delta.content };
              }
            } catch {
              // Ignore parse errors
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { type: 'done' };
  },

  async fetchModels(config: { baseUrl: string; apiKey: string }): Promise<string[]> {
    const cleanBaseUrl = config.baseUrl.replace(/\/+$/, '');
    // Try Ollama native /api/tags first
    let resp: Response;
    try {
      resp = await fetch(`${cleanBaseUrl}/api/tags`, {
        headers: config.apiKey ? { 'Authorization': `Bearer ${config.apiKey}` } : {},
      });
    } catch (e) {
      throw new Error('Cannot connect to Ollama. Make sure Ollama is running (ollama serve).');
    }
    if (!resp.ok) throw new Error(`Failed to fetch models: ${resp.status}`);
    const data = await resp.json();
    if (!Array.isArray(data.models)) return [];
    return data.models
      .map((m: { name: string }) => m.name)
      .sort();
  },

  async fetchModelDetails(config: { baseUrl: string; apiKey: string }): Promise<Record<string, number>> {
    const cleanBaseUrl = config.baseUrl.replace(/\/+$/, '');
    // First get all model names
    let resp: Response;
    try {
      resp = await fetch(`${cleanBaseUrl}/api/tags`, {
        headers: config.apiKey ? { 'Authorization': `Bearer ${config.apiKey}` } : {},
      });
    } catch {
      return {};
    }
    if (!resp.ok) return {};
    const data = await resp.json();
    if (!Array.isArray(data.models)) return {};

    const result: Record<string, number> = {};

    // Separate models into "known" (matched by static lookup table) and "wild" (unknown)
    const wildModels: string[] = [];
    for (const m of data.models) {
      const staticCtx = getModelContextWindow(m.name);
      // If static lookup returns the default 8192 fallback, it means no match → wild model
      if (staticCtx !== 8192) {
        result[m.name] = staticCtx;
      } else {
        wildModels.push(m.name);
      }
    }

    // Only query wild models via API (parallel with timeout, capped)
    const toQuery = wildModels.slice(0, MAX_WILD_MODELS_QUERY);
    if (toQuery.length > 0) {
      const queryResults = await Promise.allSettled(
        toQuery.map(async (name) => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), OLLAMA_SHOW_TIMEOUT);
          try {
            const showResp = await fetch(`${cleanBaseUrl}/api/show`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name }),
              signal: controller.signal,
            });
            if (showResp.ok) {
              const showData = await showResp.json();
              const ctx = showData.model_info?.['general.context_length']
                ?? showData.model_info?.context_length
                ?? showData.parameters?.num_ctx;
              if (typeof ctx === 'number' && ctx > 0) {
                return { name, ctx };
              }
            }
            return null;
          } finally {
            clearTimeout(timeout);
          }
        })
      );

      for (const r of queryResults) {
        if (r.status === 'fulfilled' && r.value) {
          result[r.value.name] = r.value.ctx;
        }
      }
    }

    return result;
  },
};
