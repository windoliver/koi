/**
 * LspClient — lifecycle management and LSP method wrappers.
 *
 * Manages the connection lifecycle (connect → initialize → operate → shutdown),
 * document state tracking, capability negotiation, and reconnection with
 * document re-sync.
 */

import type { KoiError, Result } from "@koi/core";
import type { ResolvedLspServerConfig } from "./config.js";
import {
  connectionTimeoutError,
  mapLspError,
  notConnectedError,
  reconnectExhaustedError,
  serverStartError,
} from "./errors.js";
import type { JsonRpcConnection } from "./jsonrpc.js";
import { createJsonRpcConnection } from "./jsonrpc.js";
import { detectLanguageId } from "./language-map.js";
import type { LspTransport } from "./transport.js";
import { createStdioTransport } from "./transport.js";
import type {
  Diagnostic,
  DocumentSymbol,
  HoverResult,
  InitializeResult,
  Location,
  Position,
  PublishDiagnosticsParams,
  Range,
  ServerCapabilities,
  SymbolInfo,
  SymbolKind,
} from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LspClient {
  readonly connect: () => Promise<Result<void, KoiError>>;
  readonly hover: (
    uri: string,
    line: number,
    character: number,
  ) => Promise<Result<HoverResult | null, KoiError>>;
  readonly gotoDefinition: (
    uri: string,
    line: number,
    character: number,
  ) => Promise<Result<readonly Location[], KoiError>>;
  readonly findReferences: (
    uri: string,
    line: number,
    character: number,
    limit?: number,
  ) => Promise<Result<readonly Location[], KoiError>>;
  readonly documentSymbols: (
    uri: string,
    limit?: number,
  ) => Promise<Result<readonly SymbolInfo[], KoiError>>;
  readonly workspaceSymbols: (
    query: string,
    limit?: number,
  ) => Promise<Result<readonly SymbolInfo[], KoiError>>;
  readonly openDocument: (
    uri: string,
    content: string,
    languageId?: string,
  ) => Promise<Result<void, KoiError>>;
  readonly closeDocument: (uri: string) => Promise<Result<void, KoiError>>;
  readonly getDiagnostics: (uri?: string) => ReadonlyMap<string, readonly Diagnostic[]>;
  readonly capabilities: () => ServerCapabilities | undefined;
  readonly close: () => Promise<void>;
  readonly isConnected: () => boolean;
  readonly serverName: () => string;
}

// ---------------------------------------------------------------------------
// Document state
// ---------------------------------------------------------------------------

interface DocumentState {
  readonly uri: string;
  readonly languageId: string;
  readonly content: string;
  readonly version: number;
}

// ---------------------------------------------------------------------------
// Factory for transport creation (DI for testing)
// ---------------------------------------------------------------------------

export type CreateTransportFn = (config: ResolvedLspServerConfig) => LspTransport;

// ---------------------------------------------------------------------------
// Type guards for untrusted server responses
// ---------------------------------------------------------------------------

function isPosition(value: unknown): value is Position {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.line === "number" && typeof obj.character === "number";
}

function isRange(value: unknown): value is Range {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return isPosition(obj.start) && isPosition(obj.end);
}

function isLocation(value: unknown): value is Location {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.uri === "string" && isRange(obj.range);
}

function isDocumentSymbol(value: unknown): value is DocumentSymbol {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.name === "string" &&
    typeof obj.kind === "number" &&
    isRange(obj.range) &&
    isRange(obj.selectionRange)
  );
}

// ---------------------------------------------------------------------------
// Flattening helpers
// ---------------------------------------------------------------------------

/**
 * Flattens a DocumentSymbol tree into a flat list of SymbolInfo.
 */
function flattenDocumentSymbols(
  symbols: readonly DocumentSymbol[],
  uri: string,
  parentName?: string,
): readonly SymbolInfo[] {
  const result: SymbolInfo[] = [];
  for (const sym of symbols) {
    result.push({
      name: sym.name,
      kind: sym.kind,
      location: { uri, range: sym.selectionRange },
      ...(parentName !== undefined ? { containerName: parentName } : {}),
    });
    if (sym.children !== undefined && sym.children.length > 0) {
      // Recursive spread is acceptable here — symbol trees are shallow
      result.push(...flattenDocumentSymbols(sym.children, uri, sym.name));
    }
  }
  return result;
}

/**
 * Normalizes definition results into a flat Location array.
 * LSP servers may return Location | Location[] | LocationLink[].
 * Validates structure of untrusted server responses.
 */
function normalizeLocations(raw: unknown): readonly Location[] {
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) {
    const locations: Location[] = [];
    for (const item of raw) {
      if (isLocation(item)) {
        locations.push(item);
        continue;
      }
      // LocationLink has targetUri + targetRange
      if (
        typeof item === "object" &&
        item !== null &&
        "targetUri" in item &&
        "targetRange" in item
      ) {
        const obj = item as Record<string, unknown>;
        if (typeof obj.targetUri === "string" && isRange(obj.targetRange)) {
          locations.push({
            uri: obj.targetUri,
            range: obj.targetRange as Range,
          });
        }
      }
    }
    return locations;
  }
  // Single Location
  if (isLocation(raw)) {
    return [raw];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates an LSP client for a specific server configuration.
 *
 * The client manages the full lifecycle: spawn → initialize → operate → shutdown.
 * Supports reconnection with document re-sync on connection loss.
 */
export function createLspClient(
  config: ResolvedLspServerConfig,
  maxReconnectAttempts: number = 3,
  connectTimeoutMs: number = 30_000,
  createTransport: CreateTransportFn = createStdioTransport,
): LspClient {
  // let is justified: mutable connection state
  let transport: LspTransport | undefined;
  let connection: JsonRpcConnection | undefined;
  let serverCapabilities: ServerCapabilities | undefined;
  let connected = false;

  // Document tracking for re-sync on reconnect
  const openDocuments = new Map<string, DocumentState>();

  // Diagnostics cache — populated by server push notifications
  const diagnosticsCache = new Map<string, readonly Diagnostic[]>();

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  async function doConnect(): Promise<Result<void, KoiError>> {
    try {
      transport = createTransport(config);
    } catch (e: unknown) {
      return { ok: false, error: serverStartError(config.name, e) };
    }

    connection = createJsonRpcConnection(transport.stdout, transport.stdin);

    // Listen for process exit
    transport.process.on("exit", () => {
      connected = false;
    });

    // Initialize handshake with timeout
    try {
      const initResult = await Promise.race([
        connection.sendRequest<InitializeResult>("initialize", {
          processId: process.pid,
          rootUri: config.rootUri,
          capabilities: {
            textDocument: {
              hover: { contentFormat: ["markdown", "plaintext"] },
              definition: { linkSupport: true },
              references: {},
              documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            },
            workspace: {
              symbol: {},
            },
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

      // Send initialized notification
      connection.sendNotification("initialized", {});

      // Subscribe to diagnostics notifications
      connection.onNotification("textDocument/publishDiagnostics", (params) => {
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

      connected = true;
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

  function cleanup(): void {
    connection?.dispose();
    transport?.dispose();
    connection = undefined;
    transport = undefined;
    connected = false;
  }

  async function reconnect(): Promise<Result<void, KoiError>> {
    cleanup();

    // let is justified: loop counter for reconnection attempts
    for (let attempt = 1; attempt <= maxReconnectAttempts; attempt++) {
      // Exponential backoff: 1s, 2s, 4s (capped at 30s)
      const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 30_000);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));

      const result = await doConnect();
      if (result.ok) {
        // Re-sync open documents
        await resyncDocuments();
        return result;
      }

      if (attempt === maxReconnectAttempts) {
        return { ok: false, error: reconnectExhaustedError(config.name, maxReconnectAttempts) };
      }
    }

    return { ok: false, error: reconnectExhaustedError(config.name, maxReconnectAttempts) };
  }

  async function resyncDocuments(): Promise<void> {
    if (connection === undefined) return;

    for (const doc of openDocuments.values()) {
      connection.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: doc.uri,
          languageId: doc.languageId,
          version: doc.version,
          text: doc.content,
        },
      });
    }
  }

  async function withConnection<T>(
    fn: (conn: JsonRpcConnection) => Promise<T>,
  ): Promise<Result<T, KoiError>> {
    if (!connected || connection === undefined) {
      return { ok: false, error: notConnectedError(config.name) };
    }

    try {
      const result = await fn(connection);
      return { ok: true, value: result };
    } catch (e: unknown) {
      // Check if this looks like a connection error — try reconnect
      const message = e instanceof Error ? e.message : String(e);
      if (/disposed|EPIPE|ECONNR|connection.*closed/i.test(message)) {
        const reconnectResult = await reconnect();
        if (reconnectResult.ok && connection !== undefined) {
          try {
            const retryResult = await fn(connection);
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

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  const connect = async (): Promise<Result<void, KoiError>> => {
    if (connected) return { ok: true, value: undefined };
    return doConnect();
  };

  const hover = async (
    uri: string,
    line: number,
    character: number,
  ): Promise<Result<HoverResult | null, KoiError>> => {
    return withConnection(async (conn) => {
      const result = await conn.sendRequest<HoverResult | null>("textDocument/hover", {
        textDocument: { uri },
        position: { line, character },
      });
      return result;
    });
  };

  const gotoDefinition = async (
    uri: string,
    line: number,
    character: number,
  ): Promise<Result<readonly Location[], KoiError>> => {
    return withConnection(async (conn) => {
      const raw = await conn.sendRequest<unknown>("textDocument/definition", {
        textDocument: { uri },
        position: { line, character },
      });
      return normalizeLocations(raw);
    });
  };

  const findReferences = async (
    uri: string,
    line: number,
    character: number,
    limit?: number,
  ): Promise<Result<readonly Location[], KoiError>> => {
    return withConnection(async (conn) => {
      const raw = await conn.sendRequest<readonly Location[] | null>("textDocument/references", {
        textDocument: { uri },
        position: { line, character },
        context: { includeDeclaration: true },
      });
      const locations = raw ?? [];
      return limit !== undefined ? locations.slice(0, limit) : locations;
    });
  };

  const documentSymbols = async (
    uri: string,
    limit?: number,
  ): Promise<Result<readonly SymbolInfo[], KoiError>> => {
    return withConnection(async (conn) => {
      const raw = await conn.sendRequest<readonly unknown[] | null>("textDocument/documentSymbol", {
        textDocument: { uri },
      });

      if (raw === null || raw.length === 0) return [];

      // Detect if response is DocumentSymbol[] (has selectionRange) or SymbolInformation[]
      const first = raw[0];
      if (first !== undefined && isDocumentSymbol(first)) {
        const validSymbols = raw.filter(isDocumentSymbol);
        const flat = flattenDocumentSymbols(validSymbols, uri);
        return limit !== undefined ? flat.slice(0, limit) : flat;
      }

      // SymbolInformation — validate each item has required fields
      const symbols: SymbolInfo[] = [];
      for (const item of raw) {
        if (
          typeof item === "object" &&
          item !== null &&
          "name" in item &&
          "kind" in item &&
          "location" in item
        ) {
          const obj = item as Record<string, unknown>;
          if (
            typeof obj.name === "string" &&
            typeof obj.kind === "number" &&
            isLocation(obj.location)
          ) {
            symbols.push({
              name: obj.name,
              kind: obj.kind as SymbolKind,
              location: obj.location as Location,
              ...(typeof obj.containerName === "string"
                ? { containerName: obj.containerName }
                : {}),
            });
          }
        }
      }
      return limit !== undefined ? symbols.slice(0, limit) : symbols;
    });
  };

  const workspaceSymbols = async (
    query: string,
    limit?: number,
  ): Promise<Result<readonly SymbolInfo[], KoiError>> => {
    return withConnection(async (conn) => {
      const raw = await conn.sendRequest<readonly SymbolInfo[] | null>("workspace/symbol", {
        query,
      });
      const symbols = raw ?? [];
      return limit !== undefined ? symbols.slice(0, limit) : symbols;
    });
  };

  const openDocument = async (
    uri: string,
    content: string,
    languageId?: string,
  ): Promise<Result<void, KoiError>> => {
    const resolvedLanguageId = languageId ?? detectLanguageId(uri) ?? "plaintext";
    const existing = openDocuments.get(uri);
    const version = existing !== undefined ? existing.version + 1 : 1;

    openDocuments.set(uri, {
      uri,
      languageId: resolvedLanguageId,
      content,
      version,
    });

    return withConnection(async (conn) => {
      // LSP requires didClose before re-opening an already-open document
      if (existing !== undefined) {
        conn.sendNotification("textDocument/didClose", {
          textDocument: { uri },
        });
      }

      conn.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: resolvedLanguageId,
          version,
          text: content,
        },
      });
    });
  };

  const closeDocument = async (uri: string): Promise<Result<void, KoiError>> => {
    openDocuments.delete(uri);
    diagnosticsCache.delete(uri);

    return withConnection(async (conn) => {
      conn.sendNotification("textDocument/didClose", {
        textDocument: { uri },
      });
    });
  };

  const getDiagnostics = (uri?: string): ReadonlyMap<string, readonly Diagnostic[]> => {
    if (uri !== undefined) {
      const diags = diagnosticsCache.get(uri);
      if (diags === undefined) return new Map();
      return new Map([[uri, diags]]);
    }
    return new Map(diagnosticsCache);
  };

  const capabilities = (): ServerCapabilities | undefined => serverCapabilities;

  const close = async (): Promise<void> => {
    if (!connected || connection === undefined) {
      cleanup();
      return;
    }

    try {
      await connection.sendRequest("shutdown", undefined, 5_000);
      connection.sendNotification("exit");
    } catch {
      // Best-effort shutdown — ignore errors
    }

    cleanup();
    openDocuments.clear();
    diagnosticsCache.clear();
  };

  const isConnected = (): boolean => connected;

  const serverNameFn = (): string => config.name;

  return {
    connect,
    hover,
    gotoDefinition,
    findReferences,
    documentSymbols,
    workspaceSymbols,
    openDocument,
    closeDocument,
    getDiagnostics,
    capabilities,
    close,
    isConnected,
    serverName: serverNameFn,
  };
}
