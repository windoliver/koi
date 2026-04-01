/**
 * McpConnection — per-server connection lifecycle manager.
 *
 * Composes the transport wrapper, state machine, auth provider, and
 * reconnection logic into a single connection handle. Owns an
 * AbortController for clean shutdown of in-flight operations.
 */

import type { JsonObject, KoiError, Result } from "@koi/core";
import { computeBackoff, DEFAULT_RECONNECT_CONFIG, sleep } from "@koi/errors";
import { Client as SdkClient } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpAuthProvider } from "./auth.js";
import type { ResolvedMcpServerConfig } from "./config.js";
import {
  connectionTimeoutError,
  mapMcpError,
  notConnectedError,
  reconnectExhaustedError,
} from "./errors.js";
import type { TransportState } from "./state.js";
import {
  createTransportStateMachine,
  type TransportStateListener,
  type TransportStateMachine,
} from "./state.js";
import type { CreateTransportFn, KoiMcpTransport } from "./transport.js";
import { createTransport as defaultCreateTransport } from "./transport.js";

// ---------------------------------------------------------------------------
// Tool info (returned by listTools)
// ---------------------------------------------------------------------------

export interface McpToolInfo {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

// ---------------------------------------------------------------------------
// SDK client abstraction (DI for testing)
// ---------------------------------------------------------------------------

interface SdkClientLike {
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
  listTools(): Promise<{
    tools: Array<{
      name: string;
      description?: string | undefined;
      inputSchema?: unknown;
    }>;
  }>;
  callTool(params: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<{ content?: unknown; isError?: boolean | undefined }>;
  setNotificationHandler?(method: string, handler: (params: unknown) => void): void;
  getServerCapabilities?(): { tools?: { listChanged?: boolean } } | undefined;
}

// ---------------------------------------------------------------------------
// Connection interface
// ---------------------------------------------------------------------------

export interface McpConnection {
  /** Connect to the MCP server. */
  readonly connect: () => Promise<Result<void, KoiError>>;
  /** List available tools on the server. */
  readonly listTools: () => Promise<Result<readonly McpToolInfo[], KoiError>>;
  /** Call a tool by name with arguments. */
  readonly callTool: (name: string, args: JsonObject) => Promise<Result<unknown, KoiError>>;
  /** Close the connection and abort in-flight operations. */
  readonly close: () => Promise<void>;
  /** Current connection state. */
  readonly state: TransportState;
  /** Server name from config. */
  readonly serverName: string;
  /** Subscribe to state changes. Returns unsubscribe function. */
  readonly onStateChange: (listener: TransportStateListener) => () => void;
  /** Subscribe to tool list changes. Returns unsubscribe function. */
  readonly onToolsChanged: (listener: () => void) => () => void;
}

// ---------------------------------------------------------------------------
// Dependency injection
// ---------------------------------------------------------------------------

export interface ConnectionDeps {
  readonly createClient: (info: {
    readonly name: string;
    readonly version: string;
  }) => SdkClientLike;
  readonly createTransport: CreateTransportFn;
  readonly random: () => number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMcpConnection(
  config: ResolvedMcpServerConfig,
  authProvider?: McpAuthProvider,
  deps?: Partial<ConnectionDeps>,
): McpConnection {
  const {
    createClient: makeClient = defaultCreateClient,
    createTransport: makeTransport = defaultCreateTransport,
    random = Math.random,
  } = deps ?? {};

  const stateMachine: TransportStateMachine = createTransportStateMachine();
  const abortController = new AbortController();

  // Mutable connection state — justified: tracks connection lifecycle
  let client: SdkClientLike | undefined;
  let transport: KoiMcpTransport | undefined;
  // Shared reconnection promise — prevents thundering herd
  let reconnecting: Promise<Result<void, KoiError>> | undefined;
  // Tool change listeners
  const toolChangeListeners = new Set<() => void>();

  // -------------------------------------------------------------------------
  // Connect
  // -------------------------------------------------------------------------

  const connect = async (): Promise<Result<void, KoiError>> => {
    if (abortController.signal.aborted) {
      return { ok: false, error: notConnectedError(config.name) };
    }

    // Only transition to connecting if not already in reconnecting
    // (ensureConnected transitions to reconnecting before calling connect)
    if (stateMachine.current.kind !== "reconnecting") {
      stateMachine.transition({ kind: "connecting", attempt: 1 });
    }

    try {
      const newTransport = makeTransport({
        config: config.server,
        authProvider,
      });

      const newClient = makeClient({
        name: `koi-mcp-${config.name}`,
        version: "1.0.0",
      });

      // Connect with AbortSignal-based timeout
      const timeoutSignal = AbortSignal.timeout(config.connectTimeoutMs);
      const composedSignal = AbortSignal.any([timeoutSignal, abortController.signal]);

      await Promise.race([
        newClient.connect(newTransport.sdkTransport),
        new Promise<never>((_, reject) => {
          composedSignal.addEventListener(
            "abort",
            () => {
              reject(connectionTimeoutError(config.name, config.connectTimeoutMs));
            },
            { once: true },
          );
        }),
      ]);

      // Clean up old connection before replacing
      if (client !== undefined) {
        try {
          await client.close();
        } catch {
          // Best-effort cleanup
        }
      }
      if (transport !== undefined) {
        try {
          await transport.close();
        } catch {
          // Best-effort cleanup
        }
      }

      client = newClient;
      transport = newTransport;

      // Wire transport lifecycle events to state machine
      newTransport.onEvent((event) => {
        if (event.kind === "closed" && stateMachine.canTransitionTo("error")) {
          stateMachine.transition({
            kind: "error",
            error: notConnectedError(config.name),
            retryable: true,
          });
        }
      });

      // Subscribe to tool change notifications
      subscribeToToolChanges(newClient);

      stateMachine.transition({
        kind: "connected",
        sessionId: newTransport.sessionId,
      });

      return { ok: true, value: undefined };
    } catch (error: unknown) {
      if (abortController.signal.aborted) {
        stateMachine.transition({ kind: "closed" });
        return { ok: false, error: notConnectedError(config.name) };
      }

      const koiError = mapMcpError(error, { serverName: config.name });

      // Check for auth challenge (401/403)
      if (koiError.code === "PERMISSION") {
        stateMachine.transition({
          kind: "auth-needed",
          challenge: { type: "bearer" },
        });
        return { ok: false, error: koiError };
      }

      stateMachine.transition({
        kind: "error",
        error: koiError,
        retryable: koiError.retryable,
      });
      return { ok: false, error: koiError };
    }
  };

  // -------------------------------------------------------------------------
  // Ensure connected (with reconnection)
  // -------------------------------------------------------------------------

  const ensureConnected = async (): Promise<Result<void, KoiError>> => {
    if (stateMachine.current.kind === "connected" && client !== undefined) {
      return { ok: true, value: undefined };
    }

    if (stateMachine.current.kind === "closed") {
      return { ok: false, error: notConnectedError(config.name) };
    }

    // Share reconnection promise to prevent thundering herd
    if (reconnecting !== undefined) {
      return reconnecting;
    }

    const doReconnect = async (): Promise<Result<void, KoiError>> => {
      // let justified: tracks previous delay for decorrelated jitter
      let prevDelay = 0;

      for (let attempt = 1; attempt <= config.maxReconnectAttempts; attempt++) {
        if (abortController.signal.aborted) {
          return { ok: false, error: notConnectedError(config.name) };
        }

        stateMachine.transition({
          kind: "reconnecting",
          attempt,
          lastError: notConnectedError(config.name),
        });

        const backoffMs = computeBackoff(
          attempt - 1,
          DEFAULT_RECONNECT_CONFIG,
          undefined,
          random,
          prevDelay,
        );
        prevDelay = backoffMs;
        await sleep(backoffMs);

        if (abortController.signal.aborted) {
          return { ok: false, error: notConnectedError(config.name) };
        }

        // Reconnect attempt reuses connect() which transitions states
        const result = await connect();
        if (result.ok) {
          return result;
        }
      }

      const exhausted = reconnectExhaustedError(config.name, config.maxReconnectAttempts);
      stateMachine.transition({
        kind: "error",
        error: exhausted,
        retryable: false,
      });
      return { ok: false, error: exhausted };
    };

    reconnecting = doReconnect().finally(() => {
      reconnecting = undefined;
    });

    return reconnecting;
  };

  // -------------------------------------------------------------------------
  // List tools
  // -------------------------------------------------------------------------

  const listTools = async (): Promise<Result<readonly McpToolInfo[], KoiError>> => {
    const connResult = await ensureConnected();
    if (!connResult.ok) return connResult;
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
      const koiError = mapMcpError(error, { serverName: config.name });
      if (stateMachine.canTransitionTo("error")) {
        stateMachine.transition({
          kind: "error",
          error: koiError,
          retryable: koiError.retryable,
        });
      }
      return { ok: false, error: koiError };
    }
  };

  // -------------------------------------------------------------------------
  // Call tool
  // -------------------------------------------------------------------------

  const callTool = async (name: string, args: JsonObject): Promise<Result<unknown, KoiError>> => {
    const connResult = await ensureConnected();
    if (!connResult.ok) return connResult;
    if (client === undefined) {
      return { ok: false, error: notConnectedError(config.name) };
    }

    try {
      const result = await client.callTool({
        name,
        arguments: args as Record<string, unknown>,
      });

      const content = result.content as readonly Record<string, unknown>[] | undefined;

      if (result.isError === true) {
        const errorText =
          content
            ?.filter(
              (
                c,
              ): c is Record<string, unknown> & {
                readonly type: "text";
                readonly text: string;
              } => c.type === "text" && typeof c.text === "string",
            )
            .map((c) => c.text)
            .join("\n") ?? "unknown error";

        return {
          ok: false,
          error: {
            code: "EXTERNAL",
            message: `MCP tool "${name}" on "${config.name}": ${errorText}`,
            retryable: false,
            context: { serverName: config.name, toolName: name },
          },
        };
      }

      return { ok: true, value: content };
    } catch (error: unknown) {
      const koiError = mapMcpError(error, { serverName: config.name });
      if (stateMachine.canTransitionTo("error")) {
        stateMachine.transition({
          kind: "error",
          error: koiError,
          retryable: koiError.retryable,
        });
      }
      return { ok: false, error: koiError };
    }
  };

  // -------------------------------------------------------------------------
  // Close
  // -------------------------------------------------------------------------

  const close = async (): Promise<void> => {
    abortController.abort();

    if (client !== undefined) {
      try {
        await client.close();
      } catch {
        // Best-effort cleanup
      }
      client = undefined;
    }

    if (transport !== undefined) {
      try {
        await transport.close();
      } catch {
        // Best-effort cleanup
      }
      transport = undefined;
    }

    if (stateMachine.canTransitionTo("closed")) {
      stateMachine.transition({ kind: "closed" });
    }
  };

  // -------------------------------------------------------------------------
  // Tool change notifications
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  return {
    connect,
    listTools,
    callTool,
    close,
    get state() {
      return stateMachine.current;
    },
    serverName: config.name,
    onStateChange: (listener) => stateMachine.onChange(listener),
    onToolsChanged: (listener) => {
      toolChangeListeners.add(listener);
      return () => {
        toolChangeListeners.delete(listener);
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Default SDK client factory
// ---------------------------------------------------------------------------

function defaultCreateClient(info: {
  readonly name: string;
  readonly version: string;
}): SdkClientLike {
  return new SdkClient(info) as unknown as SdkClientLike;
}
