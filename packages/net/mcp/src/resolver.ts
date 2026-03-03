/**
 * MCP resolver — Resolver adapter for MCP tool discovery.
 *
 * Aggregates tool descriptors across all connected MCP client managers
 * and resolves individual tools by their namespaced ID.
 *
 * Caches tool lists per-manager to avoid redundant network calls on
 * repeated load() invocations. Cache is invalidated on listTools failure.
 */

import type { KoiError, Resolver, Result, Tool, ToolDescriptor } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import type { McpClientManager, McpToolInfo } from "./client-manager.js";
import { mapMcpToolToKoi } from "./tool-adapter.js";

/**
 * Creates a Resolver that discovers and loads MCP tools across managers.
 *
 * Tool IDs follow the namespace pattern: `mcp/{serverName}/{toolName}`.
 * The resolver parses this pattern to find the correct manager and tool.
 */
export function createMcpResolver(
  managers: readonly McpClientManager[],
): Resolver<ToolDescriptor, Tool> {
  // Cache tool lists per server to avoid network calls on every load()
  const toolCache = new Map<string, readonly McpToolInfo[]>();

  const discover = async (): Promise<readonly ToolDescriptor[]> => {
    const descriptors: ToolDescriptor[] = [];

    const results = await Promise.allSettled(
      managers.map(async (manager) => {
        const result = await manager.listTools();
        if (!result.ok) {
          // Invalidate stale cache on failure
          toolCache.delete(manager.serverName());
          return [];
        }
        // Update cache on successful discovery
        toolCache.set(manager.serverName(), result.value);
        return result.value.map((tool) => ({
          name: `mcp/${manager.serverName()}/${tool.name}`,
          description: tool.description,
          inputSchema: tool.inputSchema,
        }));
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        descriptors.push(...result.value);
      }
    }

    return descriptors;
  };

  const load = async (id: string): Promise<Result<Tool, KoiError>> => {
    const parsed = parseToolId(id);
    if (parsed === undefined) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `Invalid MCP tool ID format: "${id}". Expected "mcp/{serverName}/{toolName}"`,
          retryable: RETRYABLE_DEFAULTS.NOT_FOUND,
        },
      };
    }

    const manager = managers.find((m) => m.serverName() === parsed.serverName);
    if (manager === undefined) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `MCP server "${parsed.serverName}" not found`,
          retryable: RETRYABLE_DEFAULTS.NOT_FOUND,
          context: { serverName: parsed.serverName },
        },
      };
    }

    // Use cached tool list if available, otherwise fetch
    let tools = toolCache.get(parsed.serverName);
    if (tools === undefined) {
      const toolsResult = await manager.listTools();
      if (!toolsResult.ok) {
        toolCache.delete(parsed.serverName);
        return toolsResult;
      }
      tools = toolsResult.value;
      toolCache.set(parsed.serverName, tools);
    }

    const toolInfo = tools.find((t) => t.name === parsed.toolName);
    if (toolInfo === undefined) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `Tool "${parsed.toolName}" not found on MCP server "${parsed.serverName}"`,
          retryable: RETRYABLE_DEFAULTS.NOT_FOUND,
          context: { serverName: parsed.serverName, toolName: parsed.toolName },
        },
      };
    }

    return {
      ok: true,
      value: mapMcpToolToKoi(toolInfo, manager, parsed.serverName),
    };
  };

  // --- onChange: push-based tool discovery notifications ---
  const changeListeners = new Set<() => void>();
  // let justified: mutable timer ref for debounce
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  const DEBOUNCE_MS = 100;

  const notifyListeners = (): void => {
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      // Invalidate all cached tool lists so next discover() re-fetches
      toolCache.clear();
      for (const listener of changeListeners) {
        listener();
      }
    }, DEBOUNCE_MS);
  };

  // Subscribe to each manager's onToolsChanged
  for (const manager of managers) {
    manager.onToolsChanged?.(notifyListeners);
  }

  const onChange = (listener: () => void): (() => void) => {
    changeListeners.add(listener);
    return () => {
      changeListeners.delete(listener);
    };
  };

  return { discover, load, onChange };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ParsedToolId {
  readonly serverName: string;
  readonly toolName: string;
}

function parseToolId(id: string): ParsedToolId | undefined {
  const match = /^mcp\/([^/]+)\/(.+)$/.exec(id);
  if (match === null) {
    return undefined;
  }
  const serverName = match[1];
  const toolName = match[2];
  if (serverName === undefined || toolName === undefined) {
    return undefined;
  }
  return { serverName, toolName };
}
