import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'ai.tool_use.heading') return 'Tool Calls';
      if (key === 'ai.tool_use.arguments') return 'Arguments';
      if (key === 'ai.tool_use.output') return 'Output';
      if (key === 'ai.tool_use.summary') return 'Summary';
      if (key === 'ai.tool_use.target') return 'Target';
      if (key === 'ai.tool_use.warnings') return 'Warnings';
      if (key === 'ai.tool_use.structured_data') return 'Structured Data';
      if (key === 'ai.tool_use.raw_output') return 'Output';
      if (key === 'ai.tool_use.show_raw_output') return 'Show full output';
      if (key === 'ai.tool_use.approval_required') return 'Requires approval';
      if (key === 'ai.tool_use.condensed') return `condensed ${String(options?.count ?? 0)}`;
      if (key === 'ai.tool_use.condensed_label') return 'Earlier calls';
      if (key.startsWith('ai.tool_use.tool_names.')) return key.split('.').at(-1) ?? key;
      return key;
    },
  }),
}));

vi.mock('@/store/aiChatStore', () => ({
  useAiChatStore: ((selector: (state: { resolveToolApproval: (id: string, approved: boolean) => void }) => unknown) => selector({
    resolveToolApproval: vi.fn(),
  })) as unknown,
}));

vi.mock('@/lib/ai/tools', () => ({
  hasDeniedCommands: vi.fn(() => false),
  sanitizeToolArguments: (value: unknown) => value,
  inferToolRisk: () => 'read',
  fromLegacyToolResult: (result: {
    success: boolean;
    toolName: string;
    output: string;
    error?: string;
    envelope?: unknown;
    durationMs?: number;
    truncated?: boolean;
  }) => result.envelope ?? ({
    ok: result.success,
    summary: result.error ?? result.output.split('\n')[0] ?? result.toolName,
    output: result.output,
    meta: {
      toolName: result.toolName,
      durationMs: result.durationMs ?? 0,
      truncated: result.truncated,
    },
  }),
}));

import { ToolCallBlock } from '@/components/ai/ToolCallBlock';

describe('ToolCallBlock', () => {
  it('renders tool calls derived from turn rounds when legacy toolCalls are absent', () => {
    render(
      <ToolCallBlock
        toolRounds={[
          {
            id: 'round-1',
            round: 1,
            toolCalls: [
              {
                id: 'tool-1',
                name: 'read_file',
                argumentsText: '{"path":"/tmp/demo.txt"}',
                executionState: 'completed',
              },
            ],
          },
        ]}
        turnParts={[
          {
            type: 'tool_result',
            toolCallId: 'tool-1',
            toolName: 'read_file',
            success: true,
            output: 'file body',
          },
        ]}
      />,
    );

    expect(screen.getByText('Tool Calls (1)')).toBeInTheDocument();
    expect(screen.getByText('read_file')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /read_file/i }));

    expect(screen.getByText('Arguments')).toBeInTheDocument();
    expect(screen.getAllByText(/"path":\s*"\/tmp\/demo\.txt"/).length).toBeGreaterThan(0);
    expect(screen.getByText('Output')).toBeInTheDocument();
    expect(screen.getAllByText('file body').length).toBeGreaterThan(0);
  });

  it('renders envelope summary, badges, warnings, and structured data', () => {
    render(
      <ToolCallBlock
        toolCalls={[
          {
            id: 'tool-envelope',
            name: 'write_file',
            arguments: '{"path":"/tmp/demo.txt","content":"new"}',
            status: 'completed',
            result: {
              toolCallId: 'tool-envelope',
              toolName: 'write_file',
              success: true,
              output: 'raw output'.repeat(200),
              durationMs: 25,
              envelope: {
                ok: true,
                summary: 'Written 3 bytes to /tmp/demo.txt',
                output: 'raw output'.repeat(200),
                warnings: ['unconditional overwrite'],
                data: { path: '/tmp/demo.txt', size: 3, contentHash: 'hash-1' },
                meta: {
                  toolName: 'write_file',
                  capability: 'filesystem.write',
                  targetId: 'ssh-node:node-1',
                  durationMs: 25,
                },
              },
            },
          },
        ]}
      />,
    );

    expect(screen.getByText('filesystem.write')).toBeInTheDocument();
    expect(screen.getByText(/Written 3 bytes/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /write_file/i }));

    expect(screen.getByText('Warnings')).toBeInTheDocument();
    expect(screen.getByText('unconditional overwrite')).toBeInTheDocument();
    expect(screen.getByText('Structured Data')).toBeInTheDocument();
    expect(screen.getByText(/"contentHash":\s*"hash-1"/)).toBeInTheDocument();
    expect(screen.getByText('Show full output')).toBeInTheDocument();
  });

  it('renders part-level tool calls when rounds are not available yet', () => {
    render(
      <ToolCallBlock
        turnParts={[
          {
            type: 'tool_call',
            id: 'tool-partial',
            name: 'terminal_exec',
            argumentsText: '{"command":"pwd"}',
            status: 'complete',
          },
        ]}
      />,
    );

    expect(screen.getByText('Tool Calls (1)')).toBeInTheDocument();
    expect(screen.getByText('terminal_exec')).toBeInTheDocument();
  });
});
