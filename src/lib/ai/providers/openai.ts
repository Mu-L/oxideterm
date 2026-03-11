/**
 * OpenAI Provider Adapter
 *
 * Supports native OpenAI API and any OpenAI-compatible endpoint.
 * Handles SSE streaming with `data: [DONE]` termination.
 */

import type { AiStreamProvider, AiRequestConfig, ChatMessage, AiStreamEvent, AiToolDefinition } from '../providers';

/**
 * Convert AiToolDefinition[] to OpenAI function calling format.
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

/**
 * Convert ChatMessage[] to OpenAI API message format (handles tool role).
 */
function convertMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((msg) => {
    if (msg.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: msg.tool_call_id,
        content: msg.content,
      };
    }
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      return {
        role: 'assistant',
        content: msg.content || null,
        tool_calls: msg.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
    }
    return { role: msg.role, content: msg.content };
  });
}

export const openaiProvider: AiStreamProvider = {
  type: 'openai',
  displayName: 'OpenAI',

  async *streamCompletion(
    config: AiRequestConfig,
    messages: ChatMessage[],
    signal: AbortSignal
  ): AsyncGenerator<AiStreamEvent> {
    const cleanBaseUrl = config.baseUrl.replace(/\/+$/, '');
    const url = `${cleanBaseUrl}/chat/completions`;

    const body: Record<string, unknown> = {
      model: config.model,
      messages: convertMessages(messages),
      stream: true,
      ...(config.maxResponseTokens ? { max_tokens: config.maxResponseTokens } : {}),
    };

    if (config.tools && config.tools.length > 0) {
      body.tools = convertTools(config.tools);
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `API error: ${response.status}`;
      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.error?.message || errorJson.message || errorMessage;
      } catch {
        if (errorText) errorMessage = errorText.slice(0, 200);
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
    // Track in-flight tool_calls being assembled across chunks
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
              // Flush any remaining tool calls
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

              // Handle reasoning_content (DeepSeek-R1, QwQ, etc.)
              if (delta?.reasoning_content) {
                yield { type: 'thinking', content: delta.reasoning_content };
              }

              // Handle tool_calls delta
              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  if (!pendingToolCalls.has(idx)) {
                    pendingToolCalls.set(idx, {
                      id: tc.id || '',
                      name: tc.function?.name || '',
                      arguments: '',
                    });
                  }
                  const pending = pendingToolCalls.get(idx)!;
                  if (tc.id) pending.id = tc.id;
                  if (tc.function?.name) pending.name = tc.function.name;
                  if (tc.function?.arguments) {
                    pending.arguments += tc.function.arguments;
                    // Emit incremental tool_call event for UI progress
                    yield { type: 'tool_call', id: pending.id, name: pending.name, arguments: pending.arguments };
                  }
                }
              }

              // Flush tool calls on finish_reason === 'tool_calls'
              if (finishReason === 'tool_calls') {
                for (const tc of pendingToolCalls.values()) {
                  yield { type: 'tool_call_complete', id: tc.id, name: tc.name, arguments: tc.arguments };
                }
                pendingToolCalls.clear();
              }

              const content = delta?.content || '';
              if (content) {
                yield { type: 'content', content };
              }
            } catch {
              // Ignore parse errors for partial chunks
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
    const resp = await fetch(`${cleanBaseUrl}/models`, {
      headers: { 'Authorization': `Bearer ${config.apiKey}` },
    });
    if (!resp.ok) throw new Error(`Failed to fetch models: ${resp.status}`);
    const data = await resp.json();
    if (!Array.isArray(data.data)) return [];
    // Return chat-capable models, sorted alphabetically
    const chatModels = data.data
      .map((m: { id: string }) => m.id)
      .filter((id: string) =>
        /^(gpt-|o[0-9]|chatgpt-)/.test(id) ||
        id.includes('turbo') ||
        id.includes('chat')
      )
      .sort();
    return chatModels.length > 0
      ? chatModels
      : data.data.map((m: { id: string }) => m.id).sort();
  },

  async fetchModelDetails(config: { baseUrl: string; apiKey: string }): Promise<Record<string, number>> {
    const cleanBaseUrl = config.baseUrl.replace(/\/+$/, '');
    const resp = await fetch(`${cleanBaseUrl}/models`, {
      headers: { 'Authorization': `Bearer ${config.apiKey}` },
    });
    if (!resp.ok) return {};
    const data = await resp.json();
    if (!Array.isArray(data.data)) return {};
    const result: Record<string, number> = {};
    for (const m of data.data) {
      // OpenAI returns context_window on some endpoints, or we can infer from id
      const ctx = m.context_window ?? m.context_length;
      if (typeof ctx === 'number' && ctx > 0) {
        result[m.id] = ctx;
      }
    }
    return result;
  },
};

/**
 * OpenAI-compatible provider (reuses the same implementation)
 */
export const openaiCompatibleProvider: AiStreamProvider = {
  ...openaiProvider,
  type: 'openai_compatible',
  displayName: 'OpenAI Compatible',

  async fetchModels(config: { baseUrl: string; apiKey: string }): Promise<string[]> {
    const cleanBaseUrl = config.baseUrl.replace(/\/+$/, '');
    const resp = await fetch(`${cleanBaseUrl}/models`, {
      headers: config.apiKey ? { 'Authorization': `Bearer ${config.apiKey}` } : {},
    });
    if (!resp.ok) throw new Error(`Failed to fetch models: ${resp.status}`);
    const data = await resp.json();
    if (!Array.isArray(data.data)) return [];
    return data.data.map((m: { id: string }) => m.id).sort();
  },

  async fetchModelDetails(config: { baseUrl: string; apiKey: string }): Promise<Record<string, number>> {
    const cleanBaseUrl = config.baseUrl.replace(/\/+$/, '');
    const resp = await fetch(`${cleanBaseUrl}/models`, {
      headers: config.apiKey ? { 'Authorization': `Bearer ${config.apiKey}` } : {},
    });
    if (!resp.ok) return {};
    const data = await resp.json();
    if (!Array.isArray(data.data)) return {};
    const result: Record<string, number> = {};
    for (const m of data.data) {
      const ctx = m.context_window ?? m.context_length;
      if (typeof ctx === 'number' && ctx > 0) {
        result[m.id] = ctx;
      }
    }
    return result;
  },
};
