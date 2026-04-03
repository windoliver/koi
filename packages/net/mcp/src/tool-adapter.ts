/**
 * Tool adapter — wraps MCP tools as Koi Tool components.
 *
 * Tools are namespaced as `{serverName}__{toolName}` (double underscore) to avoid
 * collisions across servers. The structured `server` field on ToolDescriptor
 * provides provenance without parsing name conventions.
 *
 * Origin is "operator" since MCP servers are operator-configured.
 */

import type { JsonObject, Tool, ToolDescriptor, ToolExecuteOptions } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import type { McpConnection, McpToolInfo } from "./connection.js";
import { normalizeToolSchema } from "./schema.js";

/** Separator used between server name and tool name in namespaced tool IDs. */
const NAMESPACE_SEP = "__";

/**
 * Validates that a server name does not contain the namespace separator.
 * Throws if the name is ambiguous.
 */
export function validateServerName(serverName: string): void {
  if (serverName.includes(NAMESPACE_SEP)) {
    throw new Error(
      `MCP server name "${serverName}" contains "${NAMESPACE_SEP}" which is used as the tool namespace separator. Rename the server to avoid ambiguity.`,
    );
  }
}

/**
 * Creates a namespaced tool name: `{serverName}__{toolName}`.
 */
export function namespacedToolName(serverName: string, toolName: string): string {
  return `${serverName}${NAMESPACE_SEP}${toolName}`;
}

/**
 * Parses a namespaced tool name back into server + tool.
 * Returns undefined if the name doesn't contain the separator.
 */
export function parseNamespacedToolName(
  name: string,
): { readonly serverName: string; readonly toolName: string } | undefined {
  const idx = name.indexOf(NAMESPACE_SEP);
  if (idx < 1) return undefined;
  return {
    serverName: name.slice(0, idx),
    toolName: name.slice(idx + NAMESPACE_SEP.length),
  };
}

/**
 * Converts an MCP tool into a Koi ToolDescriptor with a namespaced name.
 * Normalizes the input schema to valid JSON Schema.
 */
export function mapMcpToolInfoToDescriptor(
  toolInfo: McpToolInfo,
  serverName: string,
): ToolDescriptor {
  return {
    name: namespacedToolName(serverName, toolInfo.name),
    description: toolInfo.description,
    inputSchema: normalizeToolSchema(toolInfo.inputSchema),
    origin: "operator",
    server: serverName,
  };
}

/**
 * Converts an MCP tool into a full Koi Tool with execute delegate.
 *
 * The tool delegates execution to the connection's `callTool()`,
 * which handles reconnection and error mapping.
 *
 * **Cancellation limitation:** The MCP SDK does not support aborting
 * in-flight `callTool()` requests. If the engine's abort signal fires
 * mid-call, the remote operation continues to completion. We check
 * the signal before the call to fail fast, but once started, the call
 * must complete naturally. Callers should not assume a timed-out MCP
 * tool call did not execute — treat it as potentially committed.
 */
export function mapMcpToolToKoi(
  toolInfo: McpToolInfo,
  connection: McpConnection,
  serverName: string,
): Tool {
  const descriptor = mapMcpToolInfoToDescriptor(toolInfo, serverName);

  const execute = async (args: JsonObject, options?: ToolExecuteOptions): Promise<unknown> => {
    // Fail fast if already aborted — no remote call was made
    if (options?.signal?.aborted === true) {
      return {
        ok: false,
        error: {
          code: "TIMEOUT",
          message: `MCP tool "${toolInfo.name}" aborted before call`,
          retryable: false,
        },
      };
    }

    const result = await connection.callTool(toolInfo.name, args);

    // Check if aborted AFTER the call returned. The call completed
    // normally despite the signal — use the real result.
    // If the signal fired during the call, the call is still in flight
    // remotely. We return the result we have (which may be a connection
    // error if the transport was interrupted).

    if (!result.ok) {
      return {
        ok: false,
        error: {
          code: result.error.code,
          message: result.error.message,
        },
      };
    }
    return result.value;
  };

  return {
    descriptor,
    origin: "operator",
    policy: DEFAULT_UNSANDBOXED_POLICY,
    execute,
  };
}
