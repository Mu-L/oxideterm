/**
 * AI HTTP Proxy — CORS-free fetch via Tauri backend
 *
 * Routes AI provider HTTP calls through the Rust backend (reqwest) to bypass
 * browser CORS restrictions. Essential for local providers like LM Studio,
 * Ollama, and any OpenAI-compatible server.
 */

import { invoke, Channel } from '@tauri-apps/api/core';

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

type AiFetchResponse = {
  status: number;
  body: string;
};

type AiStreamChunk =
  | { type: 'status'; code: number }
  | { type: 'data'; data: string }
  | { type: 'error'; message: string };

// ═══════════════════════════════════════════════════════════════════════════
// Non-streaming fetch
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Non-streaming HTTP fetch through Tauri backend (bypasses CORS).
 * Used for model listing, model details, and other simple API calls.
 */
export async function aiFetch(
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  }
): Promise<{ ok: boolean; status: number; body: string }> {
  const resp = await invoke<AiFetchResponse>('ai_fetch', {
    url,
    method: init?.method ?? 'GET',
    headers: init?.headers ?? {},
    body: init?.body ?? null,
    timeoutMs: init?.timeoutMs ?? null,
  });
  return {
    ok: resp.status >= 200 && resp.status < 300,
    status: resp.status,
    body: resp.body,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Streaming fetch
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Streaming HTTP fetch through Tauri backend (bypasses CORS).
 * Returns a Response-like object with a readable body stream.
 *
 * The backend sends chunks via a Tauri Channel which are reassembled into
 * a ReadableStream that existing SSE parsing code can consume unchanged.
 */
export function aiFetchStreaming(
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  }
): {
  /** Promise that resolves with { ok, status } once the HTTP status is known */
  response: Promise<{ ok: boolean; status: number }>;
  /** ReadableStream of UTF-8 encoded response body chunks */
  body: ReadableStream<Uint8Array>;
} {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array>;

  // Status is delivered as the first channel event
  let statusResolve: (val: { ok: boolean; status: number }) => void;
  let statusReject: (err: Error) => void;
  const response = new Promise<{ ok: boolean; status: number }>((resolve, reject) => {
    statusResolve = resolve;
    statusReject = reject;
    // Safety timeout: reject if backend never sends Status event (e.g. crash)
    setTimeout(() => reject(new Error('AI proxy: backend did not respond')), 30000);
  });

  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });

  const channel = new Channel<AiStreamChunk>();
  channel.onmessage = (msg) => {
    switch (msg.type) {
      case 'status':
        statusResolve({ ok: msg.code >= 200 && msg.code < 300, status: msg.code });
        break;
      case 'data':
        try {
          controller.enqueue(encoder.encode(msg.data));
        } catch {
          // Stream already closed
        }
        break;
      case 'error':
        try {
          controller.error(new Error(msg.message));
        } catch {
          // Stream already errored/closed
        }
        break;
    }
  };

  // Start the streaming request (runs in background, resolves when stream ends)
  invoke('ai_fetch_stream', {
    url,
    method: init.method,
    headers: init.headers,
    body: init.body,
    onChunk: channel,
  })
    .then(() => {
      try {
        controller.close();
      } catch {
        // Already closed
      }
    })
    .catch((err) => {
      // If status hasn't been resolved yet, reject it
      statusReject(new Error(String(err)));
      try {
        controller.error(new Error(String(err)));
      } catch {
        // Already errored
      }
    });

  return { response, body };
}
