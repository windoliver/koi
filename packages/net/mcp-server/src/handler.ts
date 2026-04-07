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
// Constants
// ---------------------------------------------------------------------------

/** Maximum serialized response size in characters (1 MB). */
const MAX_RESPONSE_CHARS = 1_000_000;

/** Maximum tool execution time in milliseconds (30 seconds). */
const TOOL_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

/** Race a promise against a deadline. Aborts the controller and rejects on timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number, controller?: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller?.abort();
      reject(new Error("Tool execution timed out"));
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Type guard for JSON object values at system boundary. */
function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keys that can cause prototype pollution when merged with Object.assign or spread. */
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Deep-clone arguments into safe null-prototype objects, stripping dangerous keys. */
function sanitizeArgs(obj: JsonObject): JsonObject {
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    result[key] = sanitizeValue(value);
  }
  return result as JsonObject;
}

function sanitizeValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sanitizeValue);
  return sanitizeArgs(value as JsonObject);
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
    try {
      const entries = toolCache.list();
      return {
        tools: entries.map((e) => ({
          name: e.descriptor.name,
          description: e.descriptor.description,
          inputSchema: mapInputSchema(e.descriptor.inputSchema),
        })),
      };
    } catch (_err: unknown) {
      return { tools: [] };
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const rawName = request.params.name;
    if (typeof rawName !== "string" || rawName.length === 0 || rawName.length > 256) {
      return {
        content: [{ type: "text" as const, text: "Invalid tool name" }],
        isError: true,
      };
    }
    const name = rawName;

    // Validate arguments at system boundary
    const rawArgs: unknown = request.params.arguments ?? {};
    if (!isJsonObject(rawArgs)) {
      return {
        content: [{ type: "text" as const, text: "Invalid arguments: expected a JSON object" }],
        isError: true,
      };
    }

    const controller = new AbortController();
    try {
      const entry = toolCache.get(name);
      if (entry === undefined) {
        return {
          content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
          isError: true,
        };
      }
      const result = await withTimeout(
        entry.execute(sanitizeArgs(rawArgs), { signal: controller.signal }),
        TOOL_TIMEOUT_MS,
        controller,
      );
      // Fail fast for oversized string results before serialization
      if (typeof result === "string" && result.length > MAX_RESPONSE_CHARS) {
        return {
          content: [{ type: "text" as const, text: `Tool "${name}" response exceeds size limit` }],
          isError: true,
        };
      }
      const text = typeof result === "string" ? result : (JSON.stringify(result) ?? "");
      if (text.length > MAX_RESPONSE_CHARS) {
        return {
          content: [{ type: "text" as const, text: `Tool "${name}" response exceeds size limit` }],
          isError: true,
        };
      }
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
