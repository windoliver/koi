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
// Auth outcome type
// ---------------------------------------------------------------------------

/**
 * Tri-state result from an `onUnauthorized` / `handleUnauthorized` attempt:
 * - "refreshed"         — new access token obtained; caller may retry silently
 * - "needs-auth"        — refresh token gone; interactive OAuth required
 * - "transient-failure" — tokens preserved but temporarily unavailable; retry later
 */
export type UnauthorizedOutcome = "refreshed" | "needs-auth" | "transient-failure";

// ---------------------------------------------------------------------------
// Connection interface
// ---------------------------------------------------------------------------

export interface McpConnection {
  /** Connect to the MCP server. */
  readonly connect: () => Promise<Result<void, KoiError>>;
  /**
   * Force a transport rebuild without terminating the connection.
   * Transitions through "reconnecting" state so the token manager is
   * re-consulted — use this after an auth token refresh to pick up fresh
   * credentials, even when the connection currently reports "connected".
   */
  readonly reconnect: () => Promise<Result<void, KoiError>>;
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
  /**
   * Called on a mid-session 401. Returns an `UnauthorizedOutcome`:
   * "refreshed" — fresh token obtained, caller may retry silently;
   * "needs-auth" — refresh token gone, interactive OAuth required;
   * "transient-failure" — tokens preserved but temporarily unavailable.
   */
  readonly onUnauthorized?: () => UnauthorizedOutcome | Promise<UnauthorizedOutcome>;
  /**
   * Called when a mid-session 401 triggers auth-needed. The implementation
   * should perform the full OAuth flow and return true when tokens are ready,
   * or false if auth was cancelled or failed. When true is returned, the
   * connection will reconnect and retry the operation automatically.
   */
  readonly onAuthNeeded?: () => Promise<boolean>;
  /**
   * Called after a successful interactive auth flow AND a successful reconnect.
   * Fires after the connection is re-established so consumers receive a true
   * "auth + connection ready" signal rather than "auth completed" prematurely.
   * Best-effort — errors are swallowed. Optional.
   */
  readonly onAuthComplete?: () => Promise<void>;
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
    onUnauthorized,
    onAuthNeeded,
    onAuthComplete,
  } = deps ?? {};

  const stateMachine: TransportStateMachine = createTransportStateMachine();
  const abortController = new AbortController();

  // Mutable connection state — justified: tracks connection lifecycle
  let client: SdkClientLike | undefined;
  let transport: KoiMcpTransport | undefined;
  // Shared reconnection promise — prevents thundering herd
  let reconnecting: Promise<Result<void, KoiError>> | undefined;
  // Singleflight for auth flow — prevents concurrent onAuthNeeded calls.
  // Carries a Result so reconnect failures surface as real errors rather than
  // being collapsed into the original AUTH_REQUIRED that triggered the flow.
  let authInFlight: Promise<Result<void, KoiError>> | undefined;
  // Tool change listeners
  const toolChangeListeners = new Set<() => void>();

  // -------------------------------------------------------------------------
  // Auth flow (singleflight — deduplicates concurrent onAuthNeeded calls)
  // -------------------------------------------------------------------------

  // Error returned when auth is declined or no handler is wired — the server
  // still requires authentication so AUTH_REQUIRED is the correct code.
  const authDeclinedError = (): KoiError => ({
    code: "AUTH_REQUIRED",
    message: `${config.name} requires authentication`,
    retryable: true,
    context: { serverName: config.name },
  });

  const runAuthFlow = (): Promise<Result<void, KoiError>> => {
    if (authInFlight !== undefined) return authInFlight;
    authInFlight = (async (): Promise<Result<void, KoiError>> => {
      const outcome = await Promise.resolve(onUnauthorized?.()).catch(
        (): UnauthorizedOutcome => "transient-failure",
      );
      if (outcome === "refreshed") {
        const silentResult = await connect(true);
        if (silentResult.ok) {
          return { ok: true, value: undefined }; // self-healed without browser prompt
        }
        // Silent reconnect failed despite fresh token — fall through to interactive.
      }
      if (outcome === "transient-failure") {
        // Tokens exist but the refresh endpoint is temporarily unavailable.
        // Do NOT launch browser auth — a network blip must not trigger user-visible
        // re-consent. Return a retryable error; the session can self-heal when the
        // refresh endpoint recovers. Explicit re-auth (triggerMcpServerAuth) falls
        // through to startAuthFlow even on transient-failure because it is user-initiated.
        return {
          ok: false,
          error: {
            code: "EXTERNAL",
            message: `${config.name}: token refresh temporarily unavailable. Retry later.`,
            retryable: true,
            context: { serverName: config.name },
          },
        };
      }
      // "needs-auth" — interactive OAuth required.
      if (onAuthNeeded === undefined) {
        return { ok: false, error: authDeclinedError() };
      }
      try {
        const authed = await onAuthNeeded();
        if (!authed) {
          return { ok: false, error: authDeclinedError() };
        }
        // Include the reconnect inside the singleflight so concurrent callers
        // awaiting authInFlight see the connected state when they wake up and
        // cannot race to call connect() simultaneously on the same connection.
        const reconnResult = await connect(true);
        // Propagate reconnect failures so callers can surface the real error
        // (transport outage, server 5xx) instead of a misleading AUTH_REQUIRED.
        if (!reconnResult.ok) return reconnResult;
        // Fire onAuthComplete only after a successful reconnect so consumers
        // receive a "auth + connection ready" signal, not a premature success.
        await Promise.resolve(onAuthComplete?.()).catch(() => {});
        return { ok: true, value: undefined };
      } catch (e: unknown) {
        // Preserve the real failure cause for observability instead of silently
        // swallowing it. The caller surfaces AUTH_REQUIRED separately; this log
        // provides the concrete reason (port bind failure, discovery error, etc.)
        console.error(`[koi mcp] auth flow error for "${config.name}":`, e);
        return { ok: false, error: authDeclinedError() };
      }
    })().finally(() => {
      authInFlight = undefined;
    });
    return authInFlight;
  };

  // -------------------------------------------------------------------------
  // Connect
  // -------------------------------------------------------------------------

  const connect = async (skipRefresh = false): Promise<Result<void, KoiError>> => {
    if (abortController.signal.aborted) {
      return { ok: false, error: notConnectedError(config.name) };
    }

    // Only transition to connecting if not already in reconnecting
    // (ensureConnected transitions to reconnecting before calling connect)
    if (stateMachine.current.kind !== "reconnecting") {
      stateMachine.transition({ kind: "connecting", attempt: 1 });
    }

    // Track newly created resources so we can clean them up on failure
    let newTransport: KoiMcpTransport | undefined;
    let newClient: SdkClientLike | undefined;

    try {
      // Timeout covers the entire connect sequence: transport creation
      // (including async token retrieval) + SDK client connect.
      const timeoutSignal = AbortSignal.timeout(config.connectTimeoutMs);
      const composedSignal = AbortSignal.any([timeoutSignal, abortController.signal]);

      const connectSequence = async (): Promise<void> => {
        const t = await makeTransport({
          config: config.server,
          authProvider,
        });
        // If timed out during transport creation, close the orphan immediately
        if (composedSignal.aborted) {
          await t.close().catch(() => {});
          return;
        }
        newTransport = t;

        const c = makeClient({
          name: `koi-mcp-${config.name}`,
          version: "1.0.0",
        });
        newClient = c;

        await c.connect(t.sdkTransport);
      };

      await Promise.race([
        connectSequence(),
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

      // connectSequence may have returned early due to abort — verify we have both
      if (newTransport === undefined || newClient === undefined) {
        return { ok: false, error: notConnectedError(config.name) };
      }

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
        if (!stateMachine.canTransitionTo("error")) return;
        const error =
          event.kind === "error"
            ? mapMcpError(event.error, { serverName: config.name })
            : notConnectedError(config.name);
        stateMachine.transition({
          kind: "error",
          error,
          retryable: error.retryable,
        });
      });

      // Subscribe to tool change notifications
      subscribeToToolChanges(newClient);

      stateMachine.transition({
        kind: "connected",
        sessionId: newTransport.sessionId,
      });

      return { ok: true, value: undefined };
    } catch (error: unknown) {
      // Clean up the failed new client/transport to prevent resource leaks.
      // A timed-out connect may still be running — closing stops the process/socket.
      if (newClient !== undefined) {
        try {
          await newClient.close();
        } catch {
          // Best-effort cleanup
        }
      }
      if (newTransport !== undefined) {
        try {
          await newTransport.close();
        } catch {
          // Best-effort cleanup
        }
      }

      if (abortController.signal.aborted) {
        if (stateMachine.canTransitionTo("closed")) {
          stateMachine.transition({ kind: "closed" });
        }
        return { ok: false, error: notConnectedError(config.name) };
      }

      const koiError = mapMcpError(error, { serverName: config.name });

      // Check for auth challenge (401 only, not 403 scope denials).
      // "refreshed" → retry once with a fresh token.
      // "needs-auth" / "transient-failure" → fall through to auth-needed transition.
      if (koiError.code === "AUTH_REQUIRED") {
        if (!skipRefresh && onUnauthorized !== undefined) {
          const outcome = await Promise.resolve(onUnauthorized()).catch(
            (): UnauthorizedOutcome => "transient-failure",
          );
          if (outcome === "refreshed") {
            return connect(true); // retry once; skipRefresh prevents infinite loop
          }
        }
        if (stateMachine.canTransitionTo("auth-needed")) {
          stateMachine.transition({
            kind: "auth-needed",
            challenge: { type: "bearer" },
          });
        }
        return { ok: false, error: koiError };
      }

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
  // Ensure connected (with reconnection)
  // -------------------------------------------------------------------------

  const ensureConnected = async (): Promise<Result<void, KoiError>> => {
    if (stateMachine.current.kind === "connected" && client !== undefined) {
      return { ok: true, value: undefined };
    }

    if (stateMachine.current.kind === "closed") {
      return { ok: false, error: notConnectedError(config.name) };
    }

    // auth-needed → if auth flow is in progress, await it (auth+reconnect are
    // now atomic in the singleflight), then check state. Checking state rather
    // than `client !== undefined` prevents using a stale pre-auth client that
    // hasn't been replaced yet during the reconnect window.
    if (stateMachine.current.kind === "auth-needed") {
      if (authInFlight !== undefined) {
        await authInFlight;
        // Re-read state: authInFlight now covers auth+reconnect, so state
        // may have advanced to "connected" by the time we wake up.
        // Cast breaks TS narrowing from the outer auth-needed guard.
        const postAuthState = stateMachine.current.kind as TransportState["kind"];
        if (postAuthState === "connected" && client !== undefined) {
          return { ok: true, value: undefined };
        }
      }
      return connect();
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

  const listTools = async (
    skipRefresh = false,
  ): Promise<Result<readonly McpToolInfo[], KoiError>> => {
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
      // 401 mid-session → attempt token refresh before escalating to
      // interactive auth, so sessions with a valid refresh token self-heal.
      // 403 (insufficient scope, ACL denial) stays as a normal error.
      if (koiError.code === "AUTH_REQUIRED") {
        if (!skipRefresh && onUnauthorized !== undefined) {
          const outcome = await Promise.resolve(onUnauthorized()).catch(
            (): UnauthorizedOutcome => "transient-failure",
          );
          if (outcome === "refreshed") {
            const reconnResult = await connect(true);
            if (reconnResult.ok) {
              return listTools(true); // retry with fresh token
            }
          }
        }
        if (stateMachine.canTransitionTo("auth-needed")) {
          stateMachine.transition({
            kind: "auth-needed",
            challenge: { type: "oauth" },
          });
        }
        return { ok: false, error: koiError };
      }
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
    // If a prior passive discovery (listTools/connect) put the connection in
    // auth-needed, run the interactive OAuth flow now before ensureConnected()
    // attempts a plain reconnect that would just return AUTH_REQUIRED again.
    // Skip if a reconnect is already in progress (e.g., concurrent getMcpStatus)
    // so we don't race with a legitimate reconnect that will resolve auth-needed.
    if (
      stateMachine.current.kind === "auth-needed" &&
      authInFlight === undefined &&
      reconnecting === undefined
    ) {
      // runAuthFlow now includes connect() so the full auth+reconnect is
      // atomic in one singleflight promise.
      await runAuthFlow();
    }
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
      return parseCallToolResult(result, name, config.name);
    } catch (error: unknown) {
      const koiError = mapMcpError(error, { serverName: config.name });
      // 401 mid-session → auth-needed. 403 (insufficient scope, ACL denial)
      // stays as a normal error — don't clear valid credentials.
      if (koiError.code === "AUTH_REQUIRED") {
        if (stateMachine.canTransitionTo("auth-needed")) {
          stateMachine.transition({
            kind: "auth-needed",
            challenge: { type: "oauth" },
          });
        }
        // runAuthFlow includes connect() in its singleflight, so after it
        // resolves, client is either set (auth+reconnect succeeded) or undefined.
        const authResult = await runAuthFlow();
        if (authResult.ok && client !== undefined) {
          try {
            const retryResult = await client.callTool({
              name,
              arguments: args as Record<string, unknown>,
            });
            return parseCallToolResult(retryResult, name, config.name);
          } catch (retryErr: unknown) {
            // Surface the actual post-auth error so callers can distinguish
            // auth failure from execution failures (timeout, revoked scope, etc.)
            return { ok: false, error: mapMcpError(retryErr, { serverName: config.name }) };
          }
        }
        // Auth declined → original AUTH_REQUIRED. Reconnect failed after auth →
        // propagate the real transport error rather than a misleading AUTH_REQUIRED.
        return { ok: false, error: authResult.ok ? koiError : authResult.error };
      }
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

  const reconnect = async (): Promise<Result<void, KoiError>> => {
    if (abortController.signal.aborted) {
      return { ok: false, error: notConnectedError(config.name) };
    }
    // Transition through "reconnecting" so connect() can run from any live state.
    // "connected" → "reconnecting" is a valid state-machine transition; connect()
    // skips its own state transition when it sees "reconnecting" already set.
    if (stateMachine.canTransitionTo("reconnecting")) {
      stateMachine.transition({
        kind: "reconnecting",
        attempt: 1,
        lastError: notConnectedError(config.name),
      });
    }
    return connect();
  };

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
    reconnect,
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
// Call tool result parser
// ---------------------------------------------------------------------------

function parseCallToolResult(
  result: { readonly content?: unknown; readonly isError?: boolean | undefined },
  toolName: string,
  serverName: string,
): Result<unknown, KoiError> {
  const content = result.content as readonly Record<string, unknown>[] | undefined;
  if (result.isError === true) {
    const errorText =
      content
        ?.filter(
          (c): c is Record<string, unknown> & { readonly type: "text"; readonly text: string } =>
            c.type === "text" && typeof c.text === "string",
        )
        .map((c) => c.text)
        .join("\n") ?? "unknown error";
    return {
      ok: false,
      error: {
        code: "EXTERNAL",
        message: `MCP tool "${toolName}" on "${serverName}": ${errorText}`,
        retryable: false,
        context: { serverName, toolName },
      },
    };
  }
  return { ok: true, value: content };
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
