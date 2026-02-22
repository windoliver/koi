/**
 * McpComponentProvider — attaches MCP tools as components to agents.
 *
 * Async factory that connects to all MCP servers in parallel, discovers
 * tools, and wraps them as Koi Tool components. Mirrors the pattern
 * from @koi/forge's createForgeComponentProviderAsync.
 */

import type { Agent, ComponentProvider, KoiError } from "@koi/core";
import { toolToken } from "@koi/core";
import type { McpClientManager } from "./client-manager.js";
import { createMcpClientManager } from "./client-manager.js";
import type { McpProviderConfig, ResolvedMcpServerConfig } from "./config.js";
import { resolveProviderConfig } from "./config.js";
import { createExecuteTool } from "./discover/execute-tool.js";
import { createSearchTool } from "./discover/search-tool.js";
import { mcpToolToKoiTool } from "./tool-adapter.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpServerFailure {
  readonly serverName: string;
  readonly error: KoiError;
}

export interface McpComponentProviderResult {
  readonly provider: ComponentProvider;
  readonly clients: readonly McpClientManager[];
  readonly failures: readonly McpServerFailure[];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** Factory function signature for creating client managers (DI for testing). */
export type CreateManagerFn = (
  config: ResolvedMcpServerConfig,
  connectTimeoutMs: number,
  maxReconnectAttempts: number,
) => McpClientManager;

async function connectAndDiscoverTools(
  serverConfig: ResolvedMcpServerConfig,
  connectTimeoutMs: number,
  maxReconnectAttempts: number,
  createManager: CreateManagerFn,
): Promise<
  | {
      readonly client: McpClientManager;
      readonly tools: Map<string, unknown>;
    }
  | {
      readonly failure: McpServerFailure;
    }
> {
  const client = createManager(serverConfig, connectTimeoutMs, maxReconnectAttempts);

  const connectResult = await client.connect();
  if (!connectResult.ok) {
    return {
      failure: {
        serverName: serverConfig.name,
        error: connectResult.error,
      },
    };
  }

  // Wrap post-connect logic in try/catch to ensure client cleanup on unexpected errors
  try {
    const tools = new Map<string, unknown>();

    if (serverConfig.mode === "discover") {
      const listResult = await client.listTools();
      if (!listResult.ok) {
        await client.close();
        return {
          failure: {
            serverName: serverConfig.name,
            error: listResult.error,
          },
        };
      }

      const searchTool = createSearchTool(serverConfig.name, listResult.value);
      const executeTool = createExecuteTool(serverConfig.name, client);

      tools.set(toolToken(searchTool.descriptor.name) as string, searchTool);
      tools.set(toolToken(executeTool.descriptor.name) as string, executeTool);
    } else {
      const listResult = await client.listTools();
      if (!listResult.ok) {
        await client.close();
        return {
          failure: {
            serverName: serverConfig.name,
            error: listResult.error,
          },
        };
      }

      for (const toolInfo of listResult.value) {
        const tool = mcpToolToKoiTool(toolInfo, client, serverConfig.name);
        tools.set(toolToken(tool.descriptor.name) as string, tool);
      }
    }

    return { client, tools };
  } catch (error: unknown) {
    // Prevent resource leak: close the connected client on unexpected failure
    await client.close();
    throw error;
  }
}

/**
 * Async factory that connects to MCP servers, discovers tools, and returns
 * a ComponentProvider that attaches them to agents.
 *
 * Failed servers produce warnings in `failures` — they don't prevent
 * successful servers from working.
 */
export async function createMcpComponentProviderAsync(
  config: McpProviderConfig,
  createManager: CreateManagerFn = createMcpClientManager,
): Promise<McpComponentProviderResult> {
  const resolved = resolveProviderConfig(config);

  const results = await Promise.allSettled(
    resolved.servers.map((serverConfig) =>
      connectAndDiscoverTools(
        serverConfig,
        resolved.connectTimeoutMs,
        resolved.maxReconnectAttempts,
        createManager,
      ),
    ),
  );

  const allTools = new Map<string, unknown>();
  const clients: McpClientManager[] = [];
  const failures: McpServerFailure[] = [];

  for (const result of results) {
    if (result.status === "rejected") {
      failures.push({
        serverName: "unknown",
        error: {
          code: "EXTERNAL",
          message: `Unexpected error: ${String(result.reason)}`,
          retryable: false,
        },
      });
      continue;
    }

    const value = result.value;
    if ("failure" in value) {
      failures.push(value.failure);
    } else {
      clients.push(value.client);
      for (const [key, tool] of value.tools) {
        allTools.set(key, tool);
      }
    }
  }

  const provider: ComponentProvider = {
    name: "mcp",
    attach: (_agent: Agent): ReadonlyMap<string, unknown> => {
      return allTools;
    },
  };

  return { provider, clients, failures };
}
