/**
 * MCP protocol handler registration.
 *
 * Registers JSON-RPC request handlers on an MCP SDK Server instance,
 * delegating tool enumeration and execution to a ToolCache.
 * Error messages are sanitized at the boundary to prevent internal leaks.
 */

import type { JsonObject } from "@koi/core";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { sanitizeMcpError } from "./errors.js";
import type { ToolCache } from "./tool-cache.js";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Type guard for JSON object values at system boundary. */
function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

/**
 * Register MCP protocol handlers (tools/list, tools/call) on an SDK Server.
 *
 * Handlers delegate to the ToolCache for tool enumeration and execution.
 * Tool results are serialized as JSON text content blocks per MCP spec.
 */
export function registerHandlers(server: Server, toolCache: ToolCache): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const entries = toolCache.list();
    return {
      tools: entries.map((e) => ({
        name: e.descriptor.name,
        description: e.descriptor.description,
        inputSchema: mapInputSchema(e.descriptor.inputSchema),
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;

    // Validate arguments at system boundary
    const rawArgs: unknown = request.params.arguments ?? {};
    if (!isJsonObject(rawArgs)) {
      return {
        content: [{ type: "text" as const, text: "Invalid arguments: expected a JSON object" }],
        isError: true,
      };
    }

    const entry = toolCache.get(name);
    if (entry === undefined) {
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    try {
      const result = await entry.execute(rawArgs);
      const text = typeof result === "string" ? result : JSON.stringify(result);
      return {
        content: [{ type: "text" as const, text }],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: sanitizeMcpError(name, err) }],
        isError: true,
      };
    }
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map a Koi JsonObject inputSchema to the MCP SDK's expected shape.
 * Readonly variance is assignment-compatible with mutable Record.
 */
function mapInputSchema(schema: JsonObject): Record<string, unknown> {
  return schema;
}
