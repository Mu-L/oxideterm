// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import { useAiChatStore } from '@/store/aiChatStore';
import { useEventLogStore } from '@/store/eventLogStore';
import { getAllEntries } from '@/lib/terminalRegistry';
import { gpuCanvasManager } from '@/lib/gpu';
import { registerMemoryDiagnosticsProvider } from './memoryDiagnosticsRegistry';

let installed = false;

function estimateStringBytes(value: string | undefined | null): number {
  return (value?.length ?? 0) * 2;
}

export function installBuiltinMemoryDiagnosticsProviders(): void {
  if (installed) return;
  installed = true;

  registerMemoryDiagnosticsProvider('terminal.registry', () => {
    const entries = getAllEntries();
    return {
      id: 'terminal.registry',
      label: 'Terminal registry',
      category: 'terminal',
      objectCount: entries.length,
      estimatedBytes: entries.length * 4096,
      risk: entries.length > 12 ? 'medium' : 'low',
      details: {
        remote: entries.filter((entry) => entry.terminalType === 'terminal').length,
        local: entries.filter((entry) => entry.terminalType === 'local_terminal').length,
      },
    };
  });

  registerMemoryDiagnosticsProvider('gpu.canvas', () => {
    const rendererCount = gpuCanvasManager.rendererCount();
    return {
      id: 'gpu.canvas',
      label: 'GPU canvas renderers',
      category: 'gpu',
      objectCount: rendererCount,
      estimatedBytes: rendererCount * 1024 * 1024,
      risk: rendererCount > 8 ? 'medium' : 'low',
      details: { rendererCount },
    };
  });

  registerMemoryDiagnosticsProvider('event.log', () => {
    const entries = useEventLogStore.getState().entries;
    return {
      id: 'event.log',
      label: 'Event log',
      category: 'events',
      objectCount: entries.length,
      estimatedBytes: entries.reduce(
        (sum, entry) => sum + estimateStringBytes(entry.title) + estimateStringBytes(entry.detail) + 256,
        0,
      ),
      risk: entries.length >= 450 ? 'medium' : 'low',
      details: { entries: entries.length },
    };
  });

  registerMemoryDiagnosticsProvider('ai.chat.frontend', () => {
    const state = useAiChatStore.getState();
    const messageCount = state.conversations.reduce((sum, conversation) => sum + conversation.messages.length, 0);
    const contentBytes = state.conversations.reduce(
      (sum, conversation) => sum + conversation.messages.reduce((inner, message) => (
        inner
        + estimateStringBytes(message.content)
        + estimateStringBytes(message.thinkingContent)
        + estimateStringBytes(message.context)
        + (message.toolResult ? estimateStringBytes(JSON.stringify(message.toolResult).slice(0, 4096)) : 0)
      ), 0),
      0,
    );

    return {
      id: 'ai.chat.frontend',
      label: 'AI chat frontend cache',
      category: 'ai',
      objectCount: messageCount,
      estimatedBytes: contentBytes,
      risk: contentBytes > 32 * 1024 * 1024 ? 'high' : contentBytes > 8 * 1024 * 1024 ? 'medium' : 'low',
      details: {
        conversations: state.conversations.length,
        loadedMessages: messageCount,
      },
    };
  });
}
