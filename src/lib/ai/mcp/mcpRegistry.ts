/**
 * MCP Server Registry — Zustand store for managing MCP server lifecycle
 */

import { create } from 'zustand';
import { useSettingsStore } from '../../../store/settingsStore';
import {
  connectMcpServer,
  disconnectMcpServer,
  callMcpTool,
  readMcpResource,
  refreshMcpTools,
} from './mcpClient';
import type {
  McpServerConfig,
  McpServerState,
  McpResource,
  McpResourceContent,
  McpCallToolResult,
  McpToolSchema,
} from './mcpTypes';
import type { AiToolDefinition } from '../providers';

type McpRegistryState = {
  servers: Map<string, McpServerState>;
  /** Reverse lookup: prefixed tool name → { serverId, originalToolName } */
  toolIndex: Map<string, { serverId: string; originalName: string }>;
  /** Connect to an MCP server */
  connect: (configId: string) => Promise<void>;
  /** Disconnect from an MCP server */
  disconnect: (configId: string) => Promise<void>;
  /** Connect all enabled servers */
  connectAll: () => Promise<void>;
  /** Disconnect all servers */
  disconnectAll: () => Promise<void>;
  /** Call a tool on the appropriate MCP server */
  callTool: (serverId: string, toolName: string, args: Record<string, unknown>) => Promise<McpCallToolResult>;
  /** Get all tools from all connected servers as AiToolDefinitions */
  getAllMcpToolDefinitions: () => AiToolDefinition[];
  /** Find which server owns a tool and return the original tool name */
  findServerForTool: (toolName: string) => { server: McpServerState; originalName: string } | undefined;
  /** Refresh tools list for a server */
  refreshTools: (configId: string) => Promise<void>;
  /** Get all resources from all connected servers */
  getAllMcpResources: () => Array<McpResource & { serverId: string; serverName: string }>;
  /** Read a specific resource from a server */
  readResource: (serverId: string, uri: string) => Promise<McpResourceContent>;
};

function getServerConfigs(): McpServerConfig[] {
  return useSettingsStore.getState().settings.ai.mcpServers ?? [];
}

function mcpToolToAiTool(tool: McpToolSchema, serverName: string): AiToolDefinition {
  return {
    name: `mcp::${serverName}::${tool.name}`,
    description: `[MCP: ${serverName}] ${tool.description ?? tool.name}`,
    parameters: tool.inputSchema as Record<string, unknown>,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Auto-Retry with Exponential Backoff
// ═══════════════════════════════════════════════════════════════════════════

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;
const retryCounters = new Map<string, number>();

function scheduleRetry(configId: string, connectFn: (id: string) => Promise<void>): void {
  const attempt = (retryCounters.get(configId) ?? 0) + 1;
  if (attempt > MAX_RETRIES) {
    console.warn(`[MCP] Giving up retry for ${configId} after ${MAX_RETRIES} attempts`);
    retryCounters.delete(configId);
    return;
  }
  retryCounters.set(configId, attempt);
  const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1); // 1s, 2s, 4s
  console.info(`[MCP] Scheduling retry #${attempt} for ${configId} in ${delay}ms`);
  setTimeout(() => {
    connectFn(configId).then(() => {
      // On success, reset counter
      const server = useMcpRegistry.getState().servers.get(configId);
      if (server?.status === 'connected') {
        retryCounters.delete(configId);
      }
    }).catch(() => {
      // connectFn already handles errors internally
    });
  }, delay);
}

/** Rebuild the toolIndex from current server states */
function rebuildToolIndex(servers: Map<string, McpServerState>): Map<string, { serverId: string; originalName: string }> {
  const index = new Map<string, { serverId: string; originalName: string }>();
  for (const server of servers.values()) {
    if (server.status !== 'connected') continue;
    for (const tool of server.tools) {
      const prefixed = `mcp::${server.config.name}::${tool.name}`;
      index.set(prefixed, { serverId: server.config.id, originalName: tool.name });
    }
  }
  return index;
}

export const useMcpRegistry = create<McpRegistryState>((set, get) => ({
  servers: new Map(),
  toolIndex: new Map(),

  connect: async (configId: string) => {
    const configs = getServerConfigs();
    const config = configs.find(c => c.id === configId);
    if (!config) return;

    // Guard against double-connect
    const existing = get().servers.get(configId);
    if (existing?.status === 'connecting' || existing?.status === 'connected') return;

    // Set connecting state
    set(state => {
      const servers = new Map(state.servers);
      servers.set(configId, { config, status: 'connecting', tools: [], resources: [] });
      return { servers };
    });

    const initial: McpServerState = { config, status: 'connecting', tools: [], resources: [] };
    const result = await connectMcpServer(initial);

    set(state => {
      const servers = new Map(state.servers);
      servers.set(configId, result);
      return { servers, toolIndex: rebuildToolIndex(servers) };
    });

    // Schedule auto-retry on SSE connect failure if configured
    if (result.status === 'error' && config.retryOnDisconnect && config.transport === 'sse') {
      scheduleRetry(configId, get().connect);
    }
  },

  disconnect: async (configId: string) => {
    const current = get().servers.get(configId);
    if (!current) return;

    const result = await disconnectMcpServer(current);

    set(state => {
      const servers = new Map(state.servers);
      servers.set(configId, result);
      return { servers, toolIndex: rebuildToolIndex(servers) };
    });
  },

  connectAll: async () => {
    const configs = getServerConfigs().filter(c => c.enabled);
    await Promise.allSettled(configs.map(c => get().connect(c.id)));
  },

  disconnectAll: async () => {
    const serverIds = Array.from(get().servers.keys());
    await Promise.allSettled(serverIds.map(id => get().disconnect(id)));
  },

  callTool: async (serverId: string, toolName: string, args: Record<string, unknown>) => {
    const server = get().servers.get(serverId);
    if (!server || server.status !== 'connected') {
      throw new Error(`MCP server ${serverId} is not connected`);
    }
    return callMcpTool(server, toolName, args);
  },

  getAllMcpToolDefinitions: () => {
    const definitions: AiToolDefinition[] = [];
    for (const server of get().servers.values()) {
      if (server.status !== 'connected') continue;
      for (const tool of server.tools) {
        definitions.push(mcpToolToAiTool(tool, server.config.name));
      }
    }
    return definitions;
  },

  findServerForTool: (toolName: string) => {
    const entry = get().toolIndex.get(toolName);
    if (!entry) return undefined;
    const server = get().servers.get(entry.serverId);
    if (!server || server.status !== 'connected') return undefined;
    return { server, originalName: entry.originalName };
  },

  refreshTools: async (configId: string) => {
    const current = get().servers.get(configId);
    if (!current || current.status !== 'connected') return;

    const tools = await refreshMcpTools(current);
    set(state => {
      const servers = new Map(state.servers);
      servers.set(configId, { ...current, tools });
      return { servers, toolIndex: rebuildToolIndex(servers) };
    });
  },

  getAllMcpResources: () => {
    const result: Array<McpResource & { serverId: string; serverName: string }> = [];
    for (const server of get().servers.values()) {
      if (server.status !== 'connected') continue;
      for (const res of server.resources) {
        result.push({ ...res, serverId: server.config.id, serverName: server.config.name });
      }
    }
    return result;
  },

  readResource: async (serverId: string, uri: string) => {
    const server = get().servers.get(serverId);
    if (!server || server.status !== 'connected') {
      throw new Error(`MCP server ${serverId} is not connected`);
    }
    return readMcpResource(server, uri);
  },
}));
