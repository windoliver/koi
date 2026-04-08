/**
 * LspClient — thin composition layer.
 *
 * Combines LspLifecycle (connection management) and LspMethods (LSP operations)
 * into the LspClient public interface.
 */

import type { KoiError, Result } from "@koi/core";
import type { ResolvedLspServerConfig } from "./config.js";
import type { CreateTransportFn } from "./lifecycle.js";
import { createLspLifecycle } from "./lifecycle.js";
import type { LspMethods } from "./methods.js";
import { createLspMethods } from "./methods.js";
import type { Diagnostic, HoverResult, Location, ServerCapabilities, SymbolInfo } from "./types.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export type { CreateTransportFn } from "./lifecycle.js";

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
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates an LSP client for a specific server configuration.
 *
 * Composes lifecycle (connection management) and methods (LSP operations).
 * Default reconnect attempts changed to 2 (from v1's 3).
 */
export function createLspClient(
  config: ResolvedLspServerConfig,
  maxReconnectAttempts: number = 2,
  connectTimeoutMs: number = 30_000,
  createTransport?: CreateTransportFn,
): LspClient {
  const lifecycle = createLspLifecycle(
    config,
    maxReconnectAttempts,
    connectTimeoutMs,
    createTransport,
  );
  const methods: LspMethods = createLspMethods(lifecycle);

  const close = async (): Promise<void> => {
    const conn = lifecycle.connection();
    if (!lifecycle.connected() || conn === undefined) {
      lifecycle.cleanup();
      return;
    }

    try {
      await conn.sendRequest("shutdown", undefined, 5_000);
      conn.sendNotification("exit");
    } catch {
      // Best-effort shutdown — ignore errors
    }

    lifecycle.cleanup();
    lifecycle.openDocuments.clear();
    lifecycle.diagnosticsCache.clear();
  };

  return {
    connect: lifecycle.connect,
    hover: methods.hover,
    gotoDefinition: methods.gotoDefinition,
    findReferences: methods.findReferences,
    documentSymbols: methods.documentSymbols,
    workspaceSymbols: methods.workspaceSymbols,
    openDocument: methods.openDocument,
    closeDocument: methods.closeDocument,
    getDiagnostics: methods.getDiagnostics,
    capabilities: methods.capabilities,
    close,
    isConnected: lifecycle.connected,
    serverName: () => config.name,
  };
}
