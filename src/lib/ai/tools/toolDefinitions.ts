/**
 * AI Tool Definitions
 *
 * Defines the built-in tools available to AI models for agentic interactions.
 * Each tool has a JSON Schema definition that gets sent to the provider API.
 */

import type { AiToolDefinition } from '../providers';

// ═══════════════════════════════════════════════════════════════════════════
// Tool Definitions
// ═══════════════════════════════════════════════════════════════════════════

export const BUILTIN_TOOLS: AiToolDefinition[] = [
  {
    name: 'terminal_exec',
    description:
      'Execute a shell command on the connected remote server (or local terminal) and return stdout/stderr. Use this for running shell commands, inspecting system state, building projects, etc.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute.',
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the command. Optional.',
        },
        timeout_secs: {
          type: 'number',
          description: 'Timeout in seconds. Default: 30.',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description:
      'Read the contents of a file on the remote server. Returns the file content as text. Best for source code, config files, and other text files.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file to read.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description:
      'Write content to a file on the remote server. Creates the file if it does not exist, overwrites if it does.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file to write.',
        },
        content: {
          type: 'string',
          description: 'Content to write to the file.',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_directory',
    description:
      'List files and directories at the given path on the remote server. Returns a recursive directory tree.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the directory to list.',
        },
        max_depth: {
          type: 'number',
          description: 'Maximum recursion depth. Default: 3.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'grep_search',
    description:
      'Search for a text pattern across files in a directory on the remote server. Returns matching lines with file paths and line numbers.',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Search pattern (regex supported).',
        },
        path: {
          type: 'string',
          description: 'Directory path to search in.',
        },
        case_sensitive: {
          type: 'boolean',
          description: 'Whether the search is case-sensitive. Default: false.',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of matches to return. Default: 50.',
        },
      },
      required: ['pattern', 'path'],
    },
  },
  {
    name: 'git_status',
    description:
      'Get the git status of a repository on the remote server. Returns the current branch and list of modified/untracked files.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the git repository root.',
        },
      },
      required: ['path'],
    },
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// Safety Classification
// ═══════════════════════════════════════════════════════════════════════════

/** Tools that only read data — safe for auto-approve */
export const READ_ONLY_TOOLS = new Set([
  'read_file',
  'list_directory',
  'grep_search',
  'git_status',
]);

/** Tools that modify state — require explicit user approval */
export const WRITE_TOOLS = new Set([
  'terminal_exec',
  'write_file',
]);

/**
 * Command deny-list for terminal_exec safety.
 * These patterns are checked against the command string before execution.
 * If any pattern matches, the command is rejected without prompting the user.
 */
export const COMMAND_DENY_LIST: RegExp[] = [
  /\brm\s+(-[rfRF\s]*)*\s*\/\s*$/,     // rm -rf /
  /\bmkfs\b/,                           // mkfs (format disk)
  /\bdd\s+if=/,                         // dd if= (raw disk write)
  /\bfdisk\b/,                          // fdisk (partition table)
  /\bshutdown\b/,                       // shutdown
  /\breboot\b/,                         // reboot
  /\bhalt\b/,                           // halt
  /\bpoweroff\b/,                       // poweroff
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/, // fork bomb
  /\bchmod\s+777\s+\//,                 // chmod 777 /
  /\bchown\s+-R\s+.*\s+\//,            // chown -R ... /
  /\biptables\s+-F\b/,                  // iptables -F (flush all rules)
  /\bsystemctl\s+disable\b/,           // systemctl disable (disable services)
];

/**
 * Check if a command is in the deny-list.
 */
export function isCommandDenied(command: string): boolean {
  return COMMAND_DENY_LIST.some((pattern) => pattern.test(command));
}
