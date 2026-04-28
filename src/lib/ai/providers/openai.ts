// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

/**
 * OpenAI Provider Adapter
 *
 * Supports native OpenAI API and any OpenAI-compatible endpoint.
 * Handles SSE streaming with `data: [DONE]` termination.
 */

import type { AiStreamProvider, AiRequestConfig, ChatMessage, AiStreamEvent, AiToolDefinition } from '../providers';
import { aiFetch, aiFetchStreaming } from '../aiFetch';

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
function mergeSystemMessages(messages: ChatMessage[]): ChatMessage[] {
  const systemContents: string[] = [];
  const nonSystemMessages: ChatMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      if (msg.content) {
        systemContents.push(msg.content);
      }
      continue;
    }
    nonSystemMessages.push(msg);
  }

  if (systemContents.length === 0) {
    return messages;
  }

  return [
    { role: 'system', content: systemContents.join('\n\n') },
    ...nonSystemMessages,
  ];
}

function shouldPreserveReasoningContent(messages: ChatMessage[], index: number, config: AiRequestConfig): boolean {
  if (config.reasoningProtocol !== 'deepseek') {
    return true;
  }
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      lastUserIndex = i;
      break;
    }
  }
  // DeepSeek only needs reasoning_content replay during a tool sub-turn.
  // Older turns can drop it to reduce payload and match their API guidance.
  return index > lastUserIndex;
}

function convertMessages(messages: ChatMessage[], config: AiRequestConfig): Array<Record<string, unknown>> {
  const normalizedMessages = mergeSystemMessages(messages);
  return normalizedMessages.map((msg, index) => {
    if (msg.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: msg.tool_call_id,
        content: msg.content,
      };
    }
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      const assistantMsg: Record<string, unknown> = {
        role: 'assistant',
        content: msg.content || null,
        tool_calls: msg.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
      // Preserve reasoning_content for thinking models (Kimi K2.5, DeepSeek-R1)
      if (msg.reasoning_content !== undefined && shouldPreserveReasoningContent(normalizedMessages, index, config)) {
        assistantMsg.reasoning_content = msg.reasoning_content;
      }
      return assistantMsg;
    }
    return { role: msg.role, content: msg.content };
  });
}

function applyReasoningOptions(body: Record<string, unknown>, config: AiRequestConfig): void {
  const effort = config.reasoningEffort ?? 'auto';
  if (effort === 'auto') return;

  if (config.reasoningProtocol === 'deepseek') {
    if (effort === 'off') {
      body.thinking = { type: 'disabled' };
      return;
    }
    body.thinking = { type: 'enabled' };
    body.reasoning_effort = effort === 'max' ? 'max' : 'high';
    return;
  }

  if (config.reasoningProtocol === 'openai') {
    if (effort === 'off') {
      body.reasoning_effort = 'minimal';
      return;
    }
    body.reasoning_effort = effort === 'max' ? 'high' : effort;
  }
}

function applyToolChoice(body: Record<string, unknown>, config: AiRequestConfig): void {
  if (!config.tools || config.tools.length === 0 || !config.toolChoice || config.toolChoice === 'auto') {
    return;
  }

  if (config.toolChoice === 'required') {
    body.tool_choice = 'required';
    return;
  }

  body.tool_choice = {
    type: 'function',
    function: { name: config.toolChoice.name },
  };
}

async function readErrorText(body: ReadableStream<Uint8Array>): Promise<string> {
  const errReader = body.getReader();
  const errDecoder = new TextDecoder();
  let errorText = '';
  try {
    while (true) {
      const { done, value } = await errReader.read();
      if (done) break;
      errorText += errDecoder.decode(value, { stream: true });
    }
  } catch { /* stream error */ }
  return errorText;
}

function parseOpenAiError(status: number, errorText: string): string {
  let errorMessage = `API error: ${status}`;
  try {
    const errorJson = JSON.parse(errorText);
    errorMessage = errorJson.error?.message || errorJson.message || errorMessage;
  } catch {
    if (errorText) errorMessage = errorText.slice(0, 200);
  }
  return errorMessage;
}

function isToolChoiceUnsupportedError(message: string): boolean {
  return /tool[_-]?choice|tool_choice|unsupported.*tool|unknown.*tool|unrecognized.*tool|invalid.*tool_choice/i.test(message);
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
      messages: convertMessages(messages, config),
      stream: true,
      ...(config.maxResponseTokens ? { max_tokens: config.maxResponseTokens } : {}),
    };
    applyReasoningOptions(body, config);

    if (config.tools && config.tools.length > 0) {
      body.tools = convertTools(config.tools);
      applyToolChoice(body, config);
    }

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
    if (config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    }

    const startRequest = (requestBody: Record<string, unknown>) => aiFetchStreaming(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal,
    });

    let { response: statusPromise, body: streamBody } = startRequest(body);
    let { ok, status } = await statusPromise;

    if (!ok) {
      let errorMessage = parseOpenAiError(status, await readErrorText(streamBody));
      if (body.tool_choice && isToolChoiceUnsupportedError(errorMessage)) {
        const fallbackBody = { ...body };
        delete fallbackBody.tool_choice;
        ({ response: statusPromise, body: streamBody } = startRequest(fallbackBody));
        ({ ok, status } = await statusPromise);
        if (ok) {
          errorMessage = '';
        } else {
          errorMessage = parseOpenAiError(status, await readErrorText(streamBody));
        }
      }
      if (!ok) {
        yield { type: 'error', message: errorMessage };
        return;
      }
    }

    const reader = streamBody.getReader();
    if (!reader) {
      yield { type: 'error', message: 'No response body' };
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    // Track in-flight tool_calls being assembled across chunks
    const pendingToolCalls = new Map<number, { id: string; name: string; arguments: string }>();

    const processDataLine = (line: string): { events: AiStreamEvent[]; done: boolean } => {
      if (!line.startsWith('data: ')) return { events: [], done: false };
      const data = line.slice(6).trim();
      if (data === '[DONE]') {
        const events: AiStreamEvent[] = [];
        for (const tc of pendingToolCalls.values()) {
          events.push({ type: 'tool_call_complete', id: tc.id, name: tc.name, arguments: tc.arguments });
        }
        pendingToolCalls.clear();
        events.push({ type: 'done' });
        return { events, done: true };
      }

      const events: AiStreamEvent[] = [];
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta;
        const finishReason = json.choices?.[0]?.finish_reason;

        if (delta?.reasoning_content) {
          events.push({ type: 'thinking', content: delta.reasoning_content });
        }

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
              events.push({ type: 'tool_call', id: pending.id, name: pending.name, arguments: pending.arguments });
            }
          }
        }

        if (finishReason === 'tool_calls') {
          for (const tc of pendingToolCalls.values()) {
            events.push({ type: 'tool_call_complete', id: tc.id, name: tc.name, arguments: tc.arguments });
          }
          pendingToolCalls.clear();
        }

        const content = delta?.content || '';
        if (content) {
          events.push({ type: 'content', content });
        }
      } catch {
        // Ignore parse errors for partial chunks
      }

      return { events, done: false };
    };

    try {
      while (true) {
        if (signal.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const processed = processDataLine(line);
          for (const event of processed.events) {
            yield event;
          }
          if (processed.done) {
            return;
          }
        }
      }

      if (buffer.trim()) {
        const processed = processDataLine(buffer.trim());
        for (const event of processed.events) {
          yield event;
        }
        if (processed.done) {
          return;
        }
      }

      if (pendingToolCalls.size > 0) {
        for (const tc of pendingToolCalls.values()) {
          yield { type: 'tool_call_complete', id: tc.id, name: tc.name, arguments: tc.arguments };
        }
        pendingToolCalls.clear();
      }
    } finally {
      reader.releaseLock();
    }

    yield { type: 'done' };
  },

  async fetchModels(config: { baseUrl: string; apiKey: string }): Promise<string[]> {
    const cleanBaseUrl = config.baseUrl.replace(/\/+$/, '');
    const resp = await aiFetch(`${cleanBaseUrl}/models`, {
      headers: config.apiKey ? { 'Authorization': `Bearer ${config.apiKey}` } : {},
    });
    if (!resp.ok) throw new Error(`Failed to fetch models: ${resp.status}`);
    const data = JSON.parse(resp.body);
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
    const resp = await aiFetch(`${cleanBaseUrl}/models`, {
      headers: config.apiKey ? { 'Authorization': `Bearer ${config.apiKey}` } : {},
    });
    if (!resp.ok) return {};
    const data = JSON.parse(resp.body);
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

  async embedTexts(config: { baseUrl: string; apiKey: string; model: string }, texts: string[]): Promise<number[][]> {
    const cleanBaseUrl = config.baseUrl.replace(/\/+$/, '');
    const resp = await aiFetch(`${cleanBaseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { 'Authorization': `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: config.model, input: texts }),
    });
    if (!resp.ok) throw new Error(`Embedding request failed: ${resp.status}`);
    const data = JSON.parse(resp.body);
    if (!Array.isArray(data.data)) throw new Error('Invalid embedding response');
    return data.data
      .sort((a: { index: number }, b: { index: number }) => a.index - b.index)
      .map((d: { embedding: number[] }) => d.embedding);
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
    const resp = await aiFetch(`${cleanBaseUrl}/models`, {
      headers: config.apiKey ? { 'Authorization': `Bearer ${config.apiKey}` } : {},
    });
    if (!resp.ok) throw new Error(`Failed to fetch models: ${resp.status}`);
    const data = JSON.parse(resp.body);
    // OpenAI format: { data: [{ id }] }, LM Studio native: { models: [{ key, display_name }] }
    const models = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
    return models.map((m: { id?: string; key?: string }) => m.id ?? m.key ?? '').filter(Boolean).sort();
  },

  async fetchModelDetails(config: { baseUrl: string; apiKey: string }): Promise<Record<string, number>> {
    const cleanBaseUrl = config.baseUrl.replace(/\/+$/, '');
    const resp = await aiFetch(`${cleanBaseUrl}/models`, {
      headers: config.apiKey ? { 'Authorization': `Bearer ${config.apiKey}` } : {},
    });
    if (!resp.ok) return {};
    const data = JSON.parse(resp.body);
    const models = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
    const result: Record<string, number> = {};
    for (const m of models) {
      const id = m.id ?? m.key;
      if (!id) continue;
      const ctx = m.context_window ?? m.context_length;
      if (typeof ctx === 'number' && ctx > 0) {
        result[id] = ctx;
      }
    }
    return result;
  },
};

export const deepseekProvider: AiStreamProvider = {
  ...openaiCompatibleProvider,
  type: 'deepseek',
  displayName: 'DeepSeek',
};
