/**
 * MCP server factory — exposes agent tools via MCP protocol.
 *
 * Creates an MCP server that bridges a Koi Agent's tools to external
 * MCP clients. Supports hot-reload of tools via ForgeStore change events.
 */

import type { Agent, ForgeStore } from "@koi/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { registerHandlers } from "./handler.js";
import type { ToolCache } from "./tool-cache.js";
import { createToolCache } from "./tool-cache.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the MCP server. */
export interface McpServerConfig {
  /** Agent whose tools to expose via MCP. */
  readonly agent: Agent;
  /** MCP SDK transport to connect to. */
  readonly transport: Transport;
  /** Server name advertised during MCP initialization. Default: agent manifest name. */
  readonly name?: string;
  /** Server version advertised during MCP initialization. Default: "1.0.0". */
  readonly version?: string;
  /** Optional forge store — enables hot-reload of forged tools. */
  readonly forgeStore?: ForgeStore;
}

/** MCP server instance with lifecycle control. */
export interface McpServer {
  /** Start the server and begin accepting MCP requests. */
  readonly start: () => Promise<void>;
  /** Stop the server and release resources. */
  readonly stop: () => Promise<void>;
  /** Number of tools currently exposed. */
  readonly toolCount: () => number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an MCP server that exposes an agent's tools via MCP protocol.
 *
 * The server uses an event-driven tool cache that subscribes to
 * ForgeStore changes for hot-reload of newly forged tools.
 */
export function createMcpServer(config: McpServerConfig): McpServer {
  const serverName = config.name ?? config.agent.manifest.name;
  const serverVersion = config.version ?? "1.0.0";

  const sdkServer = new Server(
    { name: serverName, version: serverVersion },
    {
      capabilities: {
        tools: config.forgeStore !== undefined ? { listChanged: true } : {},
      },
    },
  );

  const toolCache: ToolCache = createToolCache({
    agent: config.agent,
    ...(config.forgeStore !== undefined ? { forgeStore: config.forgeStore } : {}),
    onChange: () => {
      // Notify MCP clients that tool list has changed (hot-reload)
      void sdkServer.sendToolListChanged();
    },
  });

  registerHandlers(sdkServer, toolCache);

  return {
    start: async (): Promise<void> => {
      await sdkServer.connect(config.transport);
    },
    stop: async (): Promise<void> => {
      toolCache.dispose();
      await sdkServer.close();
    },
    toolCount: () => toolCache.count(),
  };
}
