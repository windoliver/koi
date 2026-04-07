/**
 * MCP server factory — exposes agent tools + platform capabilities via MCP.
 *
 * Merges two tool sources:
 * 1. Agent tools (v1 behavior): proxy agent.query("tool:") with hot-reload
 * 2. Platform tools (v2): mailbox, tasks, registry as real Koi Tools
 *
 * Both are capability-gated and served through a single ToolCache.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { McpServerConfig } from "./config.js";
import { validateMcpServerConfig } from "./config.js";
import { registerHandlers } from "./handler.js";
import { createPlatformTools } from "./platform-tools.js";
import type { ToolCache } from "./tool-cache.js";
import { createToolCache } from "./tool-cache.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
 * Create an MCP server that exposes agent tools and platform capabilities.
 *
 * Agent tools are discovered via agent.query("tool:") with optional
 * ForgeStore hot-reload. Platform tools are built from PlatformCapabilities.
 */
export function createMcpServer(config: McpServerConfig): McpServer {
  validateMcpServerConfig(config);

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

  // Build platform tools from capabilities (if provided)
  const platformTools =
    config.platform !== undefined ? createPlatformTools(config.platform) : undefined;

  // justified: mutable connection state for hot-reload notification guard
  let connected = false;

  const toolCache: ToolCache = createToolCache({
    agent: config.agent,
    ...(config.forgeStore !== undefined ? { forgeStore: config.forgeStore } : {}),
    ...(platformTools !== undefined ? { platformTools } : {}),
    onChange: () => {
      // Guard: only send notifications when transport is connected
      if (connected) {
        sdkServer.sendToolListChanged().catch(() => {});
      }
    },
  });

  registerHandlers(sdkServer, toolCache);

  return {
    start: async (): Promise<void> => {
      await sdkServer.connect(config.transport);
      connected = true;
    },
    stop: async (): Promise<void> => {
      connected = false;
      toolCache.dispose();
      await sdkServer.close();
    },
    toolCount: () => toolCache.count(),
  };
}
