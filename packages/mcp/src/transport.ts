/**
 * Transport factory — creates MCP SDK transport instances from config.
 *
 * Exhaustive switch on transport type ensures new transport types
 * are caught at compile time.
 *
 * Note: MCP SDK types don't use exactOptionalPropertyTypes, so we use
 * type assertions at the SDK boundary to bridge the gap.
 */

import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpTransportConfig } from "./config.js";

/** Opaque transport handle returned by MCP SDK constructors. */
export interface McpTransport {
  readonly start: () => Promise<void>;
  readonly close: () => Promise<void>;
  readonly send: (message: unknown) => Promise<void>;
}

/**
 * Creates an MCP SDK transport from a resolved transport config.
 * The returned transport has not been started — call `client.connect(transport)` to start.
 */
export function createTransport(config: McpTransportConfig): McpTransport {
  switch (config.transport) {
    case "stdio": {
      const params: { command: string; args?: string[]; env?: Record<string, string> } = {
        command: config.command,
      };
      if (config.args !== undefined) {
        params.args = [...config.args];
      }
      if (config.env !== undefined) {
        params.env = { ...config.env };
      }
      return new StdioClientTransport(params) as unknown as McpTransport;
    }
    case "http": {
      const opts =
        config.headers !== undefined
          ? { requestInit: { headers: { ...config.headers } } }
          : undefined;
      return new StreamableHTTPClientTransport(
        new URL(config.url),
        opts,
      ) as unknown as McpTransport;
    }
    case "sse": {
      const opts =
        config.headers !== undefined
          ? { requestInit: { headers: { ...config.headers } } }
          : undefined;
      return new SSEClientTransport(new URL(config.url), opts) as unknown as McpTransport;
    }
    default: {
      const _exhaustive: never = config;
      throw new Error(
        `Unknown transport type: ${String((_exhaustive as McpTransportConfig).transport)}`,
      );
    }
  }
}
