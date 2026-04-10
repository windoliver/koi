/**
 * LspLifecycle — connection lifecycle management for LSP clients.
 *
 * Manages: spawn → initialize → operate → reconnect → shutdown.
 * Supports reconnection with document re-sync on connection loss.
 * Exposes connectionPromise for transparent background warm-up.
 */

import type { KoiError, Result } from "@koi/core";
import type { ResolvedLspServerConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Content-modified retry constants (LSP error -32801)
// ---------------------------------------------------------------------------

const CONTENT_MODIFIED_CODE = -32801;
const MAX_CONTENT_MODIFIED_RETRIES = 3;
const CONTENT_MODIFIED_BACKOFF_MS = [500, 1_000, 2_000] as const;

function isContentModifiedError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return e.message.includes(`JSON-RPC error ${CONTENT_MODIFIED_CODE}`);
}

import {
  connectionTimeoutError,
  isConnectionError,
  mapLspError,
  notConnectedError,
  reconnectExhaustedError,
  serverStartError,
} from "./errors.js";
import type { JsonRpcConnection } from "./jsonrpc.js";
import { createJsonRpcConnection } from "./jsonrpc.js";
import type { LspTransport } from "./transport.js";
import { createStdioTransport } from "./transport.js";
import type { InitializeResult, PublishDiagnosticsParams, ServerCapabilities } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DocumentState {
  readonly uri: string;
  readonly languageId: string;
  readonly content: string;
  readonly version: number;
}

export type CreateTransportFn = (config: ResolvedLspServerConfig) => LspTransport;

export interface LspLifecycle {
  /** Connect and perform LSP initialize handshake. Idempotent if already connected. */
  readonly connect: () => Promise<Result<void, KoiError>>;
  /** Cleanup current connection and reconnect with backoff. Re-syncs open documents. */
  readonly reconnect: () => Promise<Result<void, KoiError>>;
  /** Dispose connection and transport. */
  readonly cleanup: () => void;
  /** Re-send didOpen for all tracked open documents. */
  readonly resyncDocuments: () => Promise<void>;
  /** Execute fn with current connection, auto-reconnecting on connection errors. */
  readonly withConnection: <T>(
    fn: (conn: JsonRpcConnection) => Promise<T>,
  ) => Promise<Result<T, KoiError>>;
  /** Whether the connection is currently established. */
  readonly connected: () => boolean;
  /** Server capabilities from the initialize handshake. */
  readonly capabilities: () => ServerCapabilities | undefined;
  /** Promise that resolves when the first connect() call completes (warm-up). */
  readonly connectionPromise: Promise<Result<void, KoiError>> | undefined;
  /** Open document tracking map (mutable, shared with methods layer). */
  readonly openDocuments: Map<string, DocumentState>;
  /** Diagnostics cache populated by server push notifications. */
  readonly diagnosticsCache: Map<string, readonly import("./types.js").Diagnostic[]>;
  /** Current JSON-RPC connection (may be undefined). */
  readonly connection: () => JsonRpcConnection | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createLspLifecycle(
  config: ResolvedLspServerConfig,
  maxReconnectAttempts: number = 2,
  connectTimeoutMs: number = 30_000,
  createTransport: CreateTransportFn = createStdioTransport,
): LspLifecycle {
  // let is justified: mutable connection state
  let transport: LspTransport | undefined;
  let conn: JsonRpcConnection | undefined;
  let serverCapabilities: ServerCapabilities | undefined;
  let isConnected = false;
  // let is justified: warm-up promise set on first connect()
  let connectionPromise: Promise<Result<void, KoiError>> | undefined;

  const openDocuments = new Map<string, DocumentState>();
  const diagnosticsCache = new Map<string, readonly import("./types.js").Diagnostic[]>();

  // -------------------------------------------------------------------------
  // Internal: doConnect
  // -------------------------------------------------------------------------

  async function doConnect(): Promise<Result<void, KoiError>> {
    try {
      transport = createTransport(config);
    } catch (e: unknown) {
      return { ok: false, error: serverStartError(config.name, e) };
    }

    conn = createJsonRpcConnection(transport.stdout, transport.stdin);

    // Listen for process exit via exited promise
    void transport.exited.then(() => {
      isConnected = false;
    });

    try {
      const initResult = await Promise.race([
        conn.sendRequest<InitializeResult>("initialize", {
          processId: process.pid,
          rootUri: config.rootUri,
          capabilities: {
            textDocument: {
              hover: { contentFormat: ["markdown", "plaintext"] },
              definition: { linkSupport: true },
              references: {},
              documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            },
            workspace: { symbol: {} },
          },
          clientInfo: { name: "koi-lsp", version: "0.0.0" },
          ...(config.initializationOptions !== undefined
            ? { initializationOptions: config.initializationOptions }
            : {}),
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), connectTimeoutMs),
        ),
      ]);

      serverCapabilities = initResult.capabilities;

      conn.sendNotification("initialized", {});

      // Handle workspace/configuration requests from server.
      // CC pattern: even with configuration: false in capabilities, TypeScript LS
      // still sends these. Return null for each requested item.
      conn.onRequest("workspace/configuration", (params) => {
        const items = (params as { items?: unknown[] } | undefined)?.items ?? [];
        return items.map(() => null);
      });

      conn.onNotification("textDocument/publishDiagnostics", (params) => {
        if (
          typeof params === "object" &&
          params !== null &&
          "uri" in params &&
          "diagnostics" in params
        ) {
          const p = params as PublishDiagnosticsParams;
          if (typeof p.uri === "string" && Array.isArray(p.diagnostics)) {
            diagnosticsCache.set(p.uri, p.diagnostics);
          }
        }
      });

      isConnected = true;
      return { ok: true, value: undefined };
    } catch (e: unknown) {
      cleanup();
      const message = e instanceof Error ? e.message : String(e);
      if (message === "timeout") {
        return { ok: false, error: connectionTimeoutError(config.name, connectTimeoutMs) };
      }
      return { ok: false, error: mapLspError(e, config.name) };
    }
  }

  // -------------------------------------------------------------------------
  // Public: cleanup
  // -------------------------------------------------------------------------

  function cleanup(): void {
    conn?.dispose();
    transport?.dispose();
    conn = undefined;
    transport = undefined;
    isConnected = false;
  }

  // -------------------------------------------------------------------------
  // Public: reconnect
  // -------------------------------------------------------------------------

  async function reconnect(): Promise<Result<void, KoiError>> {
    cleanup();

    for (let attempt = 1; attempt <= maxReconnectAttempts; attempt++) {
      // Exponential backoff: 1s, 2s (capped at 30s)
      const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 30_000);
      await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));

      const result = await doConnect();
      if (result.ok) {
        await resyncDocuments();
        return result;
      }

      if (attempt === maxReconnectAttempts) {
        return { ok: false, error: reconnectExhaustedError(config.name, maxReconnectAttempts) };
      }
    }

    return { ok: false, error: reconnectExhaustedError(config.name, maxReconnectAttempts) };
  }

  // -------------------------------------------------------------------------
  // Public: resyncDocuments
  // -------------------------------------------------------------------------

  async function resyncDocuments(): Promise<void> {
    if (conn === undefined) return;

    for (const doc of openDocuments.values()) {
      conn.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: doc.uri,
          languageId: doc.languageId,
          version: doc.version,
          text: doc.content,
        },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Public: withConnection
  // -------------------------------------------------------------------------

  async function withConnection<T>(
    fn: (c: JsonRpcConnection) => Promise<T>,
  ): Promise<Result<T, KoiError>> {
    // Await warm-up if still pending and not yet connected
    if (!isConnected && connectionPromise !== undefined) {
      await connectionPromise;
    }

    if (!isConnected || conn === undefined) {
      return { ok: false, error: notConnectedError(config.name) };
    }

    try {
      // let is justified: accumulates last error across content-modified retries
      let lastError: unknown;
      for (let attempt = 0; attempt <= MAX_CONTENT_MODIFIED_RETRIES; attempt++) {
        try {
          const result = await fn(conn);
          return { ok: true, value: result };
        } catch (e: unknown) {
          if (isContentModifiedError(e) && attempt < MAX_CONTENT_MODIFIED_RETRIES) {
            lastError = e;
            const backoffMs = CONTENT_MODIFIED_BACKOFF_MS[attempt] ?? 2_000;
            await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
            continue;
          }
          // Not a content-modified error or retries exhausted — fall through
          throw e;
        }
      }
      throw lastError; // unreachable but satisfies TS
    } catch (e: unknown) {
      if (isConnectionError(e)) {
        const reconnectResult = await reconnect();
        if (reconnectResult.ok && conn !== undefined) {
          try {
            const retryResult = await fn(conn);
            return { ok: true, value: retryResult };
          } catch (retryError: unknown) {
            return { ok: false, error: mapLspError(retryError, config.name) };
          }
        }
        return {
          ok: false,
          error: reconnectResult.ok ? notConnectedError(config.name) : reconnectResult.error,
        };
      }

      return { ok: false, error: mapLspError(e, config.name) };
    }
  }

  // -------------------------------------------------------------------------
  // Public: connect
  // -------------------------------------------------------------------------

  function connect(): Promise<Result<void, KoiError>> {
    if (isConnected) return Promise.resolve({ ok: true, value: undefined });
    if (connectionPromise !== undefined) return connectionPromise;
    connectionPromise = doConnect();
    return connectionPromise;
  }

  return {
    connect,
    reconnect,
    cleanup,
    resyncDocuments,
    withConnection,
    connected: () => isConnected,
    capabilities: () => serverCapabilities,
    get connectionPromise() {
      return connectionPromise;
    },
    openDocuments,
    diagnosticsCache,
    connection: () => conn,
  };
}
