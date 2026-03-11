/**
 * AI Tool Executor
 *
 * Dispatches tool calls to the appropriate backend APIs and returns results.
 * Uses the remote agent (JSON-RPC over SSH) when available, with fallback to
 * SFTP/exec for basic operations.
 */

import { nodeIdeExecCommand } from '../../api';
import {
  nodeAgentReadFile,
  nodeAgentWriteFile,
  nodeAgentListTree,
  nodeAgentGrep,
  nodeAgentGitStatus,
} from '../../api';
import type { AiToolResult, AgentFileEntry } from '../../../types';
import { isCommandDenied } from './toolDefinitions';

/** Max output size returned from a tool execution (bytes) */
const MAX_OUTPUT_BYTES = 8192;

/** Context needed to execute tools against the correct remote session */
export type ToolExecutionContext = {
  /** Node ID for node-first routing */
  nodeId: string;
  /** Whether the remote agent is deployed and available */
  agentAvailable: boolean;
};

/**
 * Execute a tool call and return the result.
 * Dispatches to the appropriate backend based on tool name.
 */
export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<AiToolResult> {
  const startTime = Date.now();
  const toolCallId = `exec-${Date.now()}`;

  try {
    switch (toolName) {
      case 'terminal_exec':
        return await execTerminalCommand(args, context, startTime, toolCallId);
      case 'read_file':
        return await execReadFile(args, context, startTime, toolCallId);
      case 'write_file':
        return await execWriteFile(args, context, startTime, toolCallId);
      case 'list_directory':
        return await execListDirectory(args, context, startTime, toolCallId);
      case 'grep_search':
        return await execGrepSearch(args, context, startTime, toolCallId);
      case 'git_status':
        return await execGitStatus(args, context, startTime, toolCallId);
      default:
        return {
          toolCallId,
          toolName,
          success: false,
          output: '',
          error: `Unknown tool: ${toolName}`,
          durationMs: Date.now() - startTime,
        };
    }
  } catch (e) {
    return {
      toolCallId,
      toolName,
      success: false,
      output: '',
      error: e instanceof Error ? e.message : String(e),
      durationMs: Date.now() - startTime,
    };
  }
}

function truncateOutput(output: string): { text: string; truncated: boolean } {
  if (output.length <= MAX_OUTPUT_BYTES) return { text: output, truncated: false };
  return { text: output.slice(0, MAX_OUTPUT_BYTES) + '\n... (output truncated)', truncated: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// Individual Tool Executors
// ═══════════════════════════════════════════════════════════════════════════

async function execTerminalCommand(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
  startTime: number,
  toolCallId: string,
): Promise<AiToolResult> {
  const command = args.command as string;
  if (!command) {
    return { toolCallId, toolName: 'terminal_exec', success: false, output: '', error: 'Missing required argument: command', durationMs: Date.now() - startTime };
  }

  // Safety: deny-list check
  if (isCommandDenied(command)) {
    return { toolCallId, toolName: 'terminal_exec', success: false, output: '', error: 'Command rejected: matches security deny-list', durationMs: Date.now() - startTime };
  }

  const cwd = args.cwd as string | undefined;
  const timeoutSecs = (args.timeout_secs as number) || 30;

  const result = await nodeIdeExecCommand(context.nodeId, command, cwd, timeoutSecs);
  const combined = result.stderr
    ? `${result.stdout}\n--- stderr ---\n${result.stderr}`
    : result.stdout;

  const { text, truncated } = truncateOutput(combined);

  return {
    toolCallId,
    toolName: 'terminal_exec',
    success: result.exitCode === 0 || result.exitCode === null,
    output: text,
    error: result.exitCode !== 0 && result.exitCode !== null ? `Exit code: ${result.exitCode}` : undefined,
    truncated,
    durationMs: Date.now() - startTime,
  };
}

async function execReadFile(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
  startTime: number,
  toolCallId: string,
): Promise<AiToolResult> {
  const path = args.path as string;
  if (!path) {
    return { toolCallId, toolName: 'read_file', success: false, output: '', error: 'Missing required argument: path', durationMs: Date.now() - startTime };
  }

  if (context.agentAvailable) {
    const result = await nodeAgentReadFile(context.nodeId, path);
    const { text, truncated } = truncateOutput(result.content);
    return { toolCallId, toolName: 'read_file', success: true, output: text, truncated, durationMs: Date.now() - startTime };
  }

  // Fallback: exec cat via SSH
  const result = await nodeIdeExecCommand(context.nodeId, `cat ${shellEscape(path)}`, undefined, 10);
  const { text, truncated } = truncateOutput(result.stdout);
  return {
    toolCallId,
    toolName: 'read_file',
    success: result.exitCode === 0,
    output: text,
    error: result.exitCode !== 0 ? result.stderr : undefined,
    truncated,
    durationMs: Date.now() - startTime,
  };
}

async function execWriteFile(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
  startTime: number,
  toolCallId: string,
): Promise<AiToolResult> {
  const path = args.path as string;
  const content = args.content as string;
  if (!path || content === undefined) {
    return { toolCallId, toolName: 'write_file', success: false, output: '', error: 'Missing required arguments: path, content', durationMs: Date.now() - startTime };
  }

  if (context.agentAvailable) {
    const result = await nodeAgentWriteFile(context.nodeId, path, content);
    return { toolCallId, toolName: 'write_file', success: true, output: `Written ${result.size} bytes to ${path} (hash: ${result.hash})`, durationMs: Date.now() - startTime };
  }

  // Fallback: write via SSH exec using heredoc
  // Use a random delimiter to avoid collision with content
  const delimiter = `EOF_${Date.now()}`;
  const cmd = `cat > ${shellEscape(path)} << '${delimiter}'\n${content}\n${delimiter}`;
  const result = await nodeIdeExecCommand(context.nodeId, cmd, undefined, 10);
  return {
    toolCallId,
    toolName: 'write_file',
    success: result.exitCode === 0,
    output: result.exitCode === 0 ? `Written to ${path}` : '',
    error: result.exitCode !== 0 ? result.stderr : undefined,
    durationMs: Date.now() - startTime,
  };
}

async function execListDirectory(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
  startTime: number,
  toolCallId: string,
): Promise<AiToolResult> {
  const path = args.path as string;
  if (!path) {
    return { toolCallId, toolName: 'list_directory', success: false, output: '', error: 'Missing required argument: path', durationMs: Date.now() - startTime };
  }

  const maxDepth = (args.max_depth as number) || 3;

  if (context.agentAvailable) {
    const result = await nodeAgentListTree(context.nodeId, path, maxDepth, 500);
    const output = formatTreeEntries(result.entries, '') +
      (result.truncated ? '\n... (listing truncated)' : '');
    const { text, truncated } = truncateOutput(output);
    return { toolCallId, toolName: 'list_directory', success: true, output: text, truncated, durationMs: Date.now() - startTime };
  }

  // Fallback: ls via SSH
  const result = await nodeIdeExecCommand(context.nodeId, `ls -la ${shellEscape(path)}`, undefined, 10);
  const { text, truncated } = truncateOutput(result.stdout);
  return {
    toolCallId,
    toolName: 'list_directory',
    success: result.exitCode === 0,
    output: text,
    error: result.exitCode !== 0 ? result.stderr : undefined,
    truncated,
    durationMs: Date.now() - startTime,
  };
}

async function execGrepSearch(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
  startTime: number,
  toolCallId: string,
): Promise<AiToolResult> {
  const pattern = args.pattern as string;
  const path = args.path as string;
  if (!pattern || !path) {
    return { toolCallId, toolName: 'grep_search', success: false, output: '', error: 'Missing required arguments: pattern, path', durationMs: Date.now() - startTime };
  }

  const caseSensitive = (args.case_sensitive as boolean) ?? false;
  const maxResults = (args.max_results as number) || 50;

  if (context.agentAvailable) {
    const matches = await nodeAgentGrep(context.nodeId, pattern, path, caseSensitive, maxResults);
    const output = matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join('\n');
    const { text, truncated } = truncateOutput(output || 'No matches found.');
    return { toolCallId, toolName: 'grep_search', success: true, output: text, truncated, durationMs: Date.now() - startTime };
  }

  // Fallback: grep via SSH
  const flags = caseSensitive ? '-rn' : '-rni';
  const result = await nodeIdeExecCommand(
    context.nodeId,
    `grep ${flags} --max-count=${maxResults} ${shellEscape(pattern)} ${shellEscape(path)}`,
    undefined,
    15,
  );
  const { text, truncated } = truncateOutput(result.stdout || 'No matches found.');
  return {
    toolCallId,
    toolName: 'grep_search',
    success: true, // grep returns exit 1 when no match — not an error
    output: text,
    truncated,
    durationMs: Date.now() - startTime,
  };
}

async function execGitStatus(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
  startTime: number,
  toolCallId: string,
): Promise<AiToolResult> {
  const path = args.path as string;
  if (!path) {
    return { toolCallId, toolName: 'git_status', success: false, output: '', error: 'Missing required argument: path', durationMs: Date.now() - startTime };
  }

  if (context.agentAvailable) {
    const result = await nodeAgentGitStatus(context.nodeId, path);
    const files = result.files.map((f) => `${f.status} ${f.path}`).join('\n');
    const output = `Branch: ${result.branch}\n${files || '(clean working tree)'}`;
    const { text, truncated } = truncateOutput(output);
    return { toolCallId, toolName: 'git_status', success: true, output: text, truncated, durationMs: Date.now() - startTime };
  }

  // Fallback: git status via SSH
  const result = await nodeIdeExecCommand(context.nodeId, 'git status --short --branch', path, 10);
  const { text, truncated } = truncateOutput(result.stdout);
  return {
    toolCallId,
    toolName: 'git_status',
    success: result.exitCode === 0,
    output: text,
    error: result.exitCode !== 0 ? result.stderr : undefined,
    truncated,
    durationMs: Date.now() - startTime,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Utility
// ═══════════════════════════════════════════════════════════════════════════

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function formatTreeEntries(entries: AgentFileEntry[], indent: string): string {
  return entries
    .map((e) => {
      const prefix = e.file_type === 'directory' ? `${indent}${e.name}/` : `${indent}${e.name}`;
      const children = e.children && Array.isArray(e.children) && e.children.length > 0
        ? '\n' + formatTreeEntries(e.children as typeof entries, indent + '  ')
        : '';
      return prefix + children;
    })
    .join('\n');
}
