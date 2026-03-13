/**
 * MCP (Model Context Protocol) Type Definitions
 * 
 * Based on the MCP specification for tool discovery and execution.
 * Supports SSE (HTTP) and stdio transports.
 */

// ═══════════════════════════════════════════════════════════════════════════
// Server Configuration
// ═══════════════════════════════════════════════════════════════════════════

export type McpTransport = 'sse' | 'stdio';

export type McpServerConfig = {
  /** Unique identifier for this server */
  id: string;
  /** Human-readable name */
  name: string;
  /** Transport type */
  transport: McpTransport;
  /** SSE: HTTP endpoint URL */
  url?: string;
  /** Stdio: command to execute */
  command?: string;
  /** Stdio: command arguments */
  args?: string[];
  /** Stdio: environment variables */
  env?: Record<string, string>;
  /** Whether this server is enabled */
  enabled: boolean;
  /** SSE: Bearer token for Authorization header */
  authToken?: string;
  /** Automatically retry connection on disconnect (SSE only) */
  retryOnDisconnect?: boolean;
};

// ═══════════════════════════════════════════════════════════════════════════
// Protocol Messages (JSON-RPC 2.0)
// ═══════════════════════════════════════════════════════════════════════════

export type JsonRpcRequest = {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
};

export type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

// ═══════════════════════════════════════════════════════════════════════════
// MCP Protocol Types
// ═══════════════════════════════════════════════════════════════════════════

export type McpServerCapabilities = {
  tools?: Record<string, unknown>;
  resources?: Record<string, unknown>;
  prompts?: Record<string, unknown>;
};

export type McpToolSchema = {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
};

export type McpCallToolResult = {
  content: Array<{
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
};

// ═══════════════════════════════════════════════════════════════════════════
// Resources
// ═══════════════════════════════════════════════════════════════════════════

export type McpResource = {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
};

export type McpResourceContent = {
  uri: string;
  mimeType?: string;
  text?: string;
  /** Base64-encoded binary data */
  blob?: string;
};

// ═══════════════════════════════════════════════════════════════════════════
// Runtime State
// ═══════════════════════════════════════════════════════════════════════════

export type McpServerStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export type McpServerState = {
  config: McpServerConfig;
  status: McpServerStatus;
  error?: string;
  tools: McpToolSchema[];
  /** Resources advertised by this server */
  resources: McpResource[];
  /** For stdio transport: server ID returned by Rust backend */
  runtimeId?: string;
};
