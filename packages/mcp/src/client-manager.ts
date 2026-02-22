/**
 * McpClientManager — per-server connection lifecycle + reconnection.
 *
 * Manages a single MCP client connection: connect, list tools, call tools,
 * and automatic reconnection with exponential backoff on failure.
 */

import type { JsonObject, KoiError, Result } from "@koi/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpTransportConfig, ResolvedMcpServerConfig } from "./config.js";
import {
  connectionTimeoutError,
  mapMcpError,
  notConnectedError,
  reconnectExhaustedError,
  serverStartError,
} from "./errors.js";
import { createTransport } from "./transport.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpToolInfo {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

export interface McpClientManager {
  readonly connect: () => Promise<Result<void, KoiError>>;
  readonly listTools: () => Promise<Result<readonly McpToolInfo[], KoiError>>;
  readonly callTool: (name: string, args: JsonObject) => Promise<Result<unknown, KoiError>>;
  readonly close: () => Promise<void>;
  readonly isConnected: () => boolean;
  readonly serverName: () => string;
}

// ---------------------------------------------------------------------------
// SDK abstraction (enables DI for testing)
// ---------------------------------------------------------------------------

/** Minimal interface for the MCP SDK Client methods used by this module. */
interface SdkClientLike {
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
  listTools(): Promise<{
    tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  }>;
  callTool(params: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<{ content: unknown; isError?: boolean }>;
}

/** Internal dependency injection for testing. Not part of the public API. */
export interface ClientManagerDeps {
  readonly createClient: (info: {
    readonly name: string;
    readonly version: string;
  }) => SdkClientLike;
  readonly createTransport: (config: Readonly<McpTransportConfig>) => unknown;
}

const DEFAULT_DEPS: ClientManagerDeps = {
  createClient: (info) => new Client(info),
  createTransport: (config) => createTransport(config) as unknown,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const BACKOFF_FACTOR = 2;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createMcpClientManager(
  config: ResolvedMcpServerConfig,
  connectTimeoutMs: number,
  maxReconnectAttempts: number,
  deps: ClientManagerDeps = DEFAULT_DEPS,
): McpClientManager {
  // Mutable connection state (justified: tracks connection lifecycle)
  let client: SdkClientLike | undefined;
  let connected = false;
  let reconnectAttempt = 0;
  // Shared reconnection promise to prevent thundering herd
  let reconnecting: Promise<Result<void, KoiError>> | undefined;

  const connect = async (): Promise<Result<void, KoiError>> => {
    let newClient: SdkClientLike | undefined;
    try {
      const transport = deps.createTransport(config.transport);
      newClient = deps.createClient({ name: `koi-mcp-${config.name}`, version: "1.0.0" });

      // Race connection against timeout, clearing timer on either outcome
      let timer: ReturnType<typeof setTimeout> | undefined;
      const connectPromise = newClient.connect(transport);
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(connectionTimeoutError(config.name, connectTimeoutMs));
        }, connectTimeoutMs);
      });

      try {
        await Promise.race([connectPromise, timeoutPromise]);
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }

      // Close old client before replacing to prevent resource leak
      if (client !== undefined) {
        try {
          await client.close();
        } catch {
          // Best-effort cleanup of old client
        }
      }

      client = newClient;
      connected = true;
      reconnectAttempt = 0;

      return { ok: true, value: undefined };
    } catch (error: unknown) {
      connected = false;
      // Clean up the failed new client to prevent transport/process leak
      if (newClient !== undefined) {
        try {
          await newClient.close();
        } catch {
          // Best-effort cleanup
        }
      }
      if (isKoiError(error)) {
        return { ok: false, error };
      }
      return { ok: false, error: serverStartError(config.name, error) };
    }
  };

  const ensureConnected = async (): Promise<Result<void, KoiError>> => {
    if (connected && client !== undefined) {
      return { ok: true, value: undefined };
    }

    // If another caller is already reconnecting, share that promise
    if (reconnecting !== undefined) {
      return reconnecting;
    }

    const doReconnect = async (): Promise<Result<void, KoiError>> => {
      while (reconnectAttempt < maxReconnectAttempts) {
        reconnectAttempt += 1;
        const backoffMs = Math.min(
          INITIAL_BACKOFF_MS * BACKOFF_FACTOR ** (reconnectAttempt - 1),
          MAX_BACKOFF_MS,
        );
        await sleep(backoffMs);

        const result = await connect();
        if (result.ok) {
          return result;
        }
      }

      return {
        ok: false,
        error: reconnectExhaustedError(config.name, maxReconnectAttempts),
      };
    };

    reconnecting = doReconnect().finally(() => {
      reconnecting = undefined;
    });

    return reconnecting;
  };

  const listTools = async (): Promise<Result<readonly McpToolInfo[], KoiError>> => {
    const connResult = await ensureConnected();
    if (!connResult.ok) {
      return connResult;
    }
    if (client === undefined) {
      return { ok: false, error: notConnectedError(config.name) };
    }

    try {
      const response = await client.listTools();
      const tools: readonly McpToolInfo[] = response.tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: (t.inputSchema ?? { type: "object" }) as JsonObject,
      }));
      return { ok: true, value: tools };
    } catch (error: unknown) {
      connected = false;
      return { ok: false, error: mapMcpError(error, config.name) };
    }
  };

  const callTool = async (name: string, args: JsonObject): Promise<Result<unknown, KoiError>> => {
    const connResult = await ensureConnected();
    if (!connResult.ok) {
      return connResult;
    }
    if (client === undefined) {
      return { ok: false, error: notConnectedError(config.name) };
    }

    try {
      const result = await client.callTool({
        name,
        arguments: args as Record<string, unknown>,
      });

      // MCP SDK returns complex typed content — treat as unknown at the boundary
      const content = result.content as readonly Record<string, unknown>[];

      if (result.isError === true) {
        const errorText = content
          .filter(
            (c): c is Record<string, unknown> & { readonly type: "text"; readonly text: string } =>
              c.type === "text" && typeof c.text === "string",
          )
          .map((c) => c.text)
          .join("\n");
        return {
          ok: false,
          error: {
            code: "EXTERNAL",
            message: `MCP tool "${name}" on "${config.name}": ${errorText || "unknown error"}`,
            retryable: false,
            context: { serverName: config.name, toolName: name },
          },
        };
      }

      return { ok: true, value: content };
    } catch (error: unknown) {
      connected = false;
      return { ok: false, error: mapMcpError(error, config.name) };
    }
  };

  const close = async (): Promise<void> => {
    if (client !== undefined) {
      try {
        await client.close();
      } catch {
        // Best-effort cleanup
      }
      client = undefined;
      connected = false;
    }
  };

  return {
    connect,
    listTools,
    callTool,
    close,
    isConnected: () => connected,
    serverName: () => config.name,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isKoiError(error: unknown): error is KoiError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error &&
    "retryable" in error
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
