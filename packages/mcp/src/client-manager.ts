/**
 * McpClientManager — per-server connection lifecycle + reconnection.
 *
 * Manages a single MCP client connection: connect, list tools, call tools,
 * and automatic reconnection with exponential backoff on failure.
 */

import type { JsonObject, KoiError, Result } from "@koi/core";
import { isKoiError, sleep } from "@koi/errors";
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
  /** Subscribe to tool list changes from MCP notifications/tools/list_changed. */
  readonly onToolsChanged?: (listener: () => void) => () => void;
}

// ---------------------------------------------------------------------------
// SDK abstraction (enables DI for testing)
// ---------------------------------------------------------------------------

/** Minimal interface for the MCP SDK Client methods used by this module. */
interface SdkClientLike {
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
  listTools(): Promise<{
    tools: Array<{ name: string; description?: string | undefined; inputSchema?: unknown }>;
  }>;
  callTool(params: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<{ content?: unknown; isError?: boolean | undefined }>;
  setNotificationHandler?(method: string, handler: (params: unknown) => void): void;
  getServerCapabilities?():
    | {
        tools?: { listChanged?: boolean };
        resources?: { listChanged?: boolean };
        prompts?: { listChanged?: boolean };
      }
    | undefined;
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
  // SDK Client's Zod-inferred return types don't structurally match our
  // minimal SdkClientLike interface, so we cast at this boundary.
  createClient: (info) => new Client(info) as unknown as SdkClientLike,
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
  initialBackoffMs: number = INITIAL_BACKOFF_MS,
): McpClientManager {
  // Mutable connection state (justified: tracks connection lifecycle)
  let client: SdkClientLike | undefined;
  let connected = false;
  let reconnectAttempt = 0;
  // Shared reconnection promise to prevent thundering herd
  let reconnecting: Promise<Result<void, KoiError>> | undefined;
  // Tool change listeners (justified: mutable set for pub/sub lifecycle)
  const toolChangeListeners = new Set<() => void>();

  const connect = async (): Promise<Result<void, KoiError>> => {
    let newClient: SdkClientLike | undefined;
    try {
      const transport = deps.createTransport(config.transport);
      newClient = deps.createClient({ name: `koi-mcp-${config.name}`, version: "1.0.0" });

      // Race connection against timeout using a single-promise wrapper.
      // Avoids Promise.race which leaves the losing promise as an orphaned
      // rejection that Bun's test runner reports as "Unhandled error between tests".
      const connectPromise = newClient.connect(transport);
      await new Promise<void>((resolve, reject) => {
        // let justified: prevent double-settle from concurrent resolve paths
        let settled = false;

        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(connectionTimeoutError(config.name, connectTimeoutMs));
          }
        }, connectTimeoutMs);

        connectPromise.then(
          () => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve();
            }
          },
          (error: unknown) => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              reject(error);
            }
          },
        );
      });

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

      // Subscribe to tools/list_changed notifications if server supports it
      subscribeToToolChanges(newClient);

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
          initialBackoffMs * BACKOFF_FACTOR ** (reconnectAttempt - 1),
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

  /** Subscribe to notifications/tools/list_changed if the server advertises support. */
  function subscribeToToolChanges(sdkClient: SdkClientLike): void {
    if (sdkClient.setNotificationHandler === undefined) return;
    const caps = sdkClient.getServerCapabilities?.();
    if (caps?.tools?.listChanged !== true) return;

    sdkClient.setNotificationHandler("notifications/tools/list_changed", () => {
      for (const listener of toolChangeListeners) {
        listener();
      }
    });
  }

  const onToolsChanged = (listener: () => void): (() => void) => {
    toolChangeListeners.add(listener);
    return () => {
      toolChangeListeners.delete(listener);
    };
  };

  return {
    connect,
    listTools,
    callTool,
    close,
    isConnected: () => connected,
    serverName: () => config.name,
    onToolsChanged,
  };
}
