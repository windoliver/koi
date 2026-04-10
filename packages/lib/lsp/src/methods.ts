/**
 * LspMethods — LSP method wrappers for hover, definition, references, symbols.
 *
 * All methods go through the lifecycle's withConnection for auto-reconnect.
 * Type guards and normalizers for untrusted server responses live here.
 */

import type { KoiError, Result } from "@koi/core";
import type { LspLifecycle } from "./lifecycle.js";

// ---------------------------------------------------------------------------
// File size limit for didOpen guard
// ---------------------------------------------------------------------------

const MAX_DOCUMENT_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

import { detectLanguageId } from "./language-map.js";
import type {
  Diagnostic,
  DocumentSymbol,
  HoverResult,
  Location,
  Position,
  Range,
  ServerCapabilities,
  SymbolInfo,
  SymbolKind,
} from "./types.js";

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
      result.push(...flattenDocumentSymbols(sym.children, uri, sym.name));
    }
  }
  return result;
}

function normalizeLocations(raw: unknown): readonly Location[] {
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) {
    const locations: Location[] = [];
    for (const item of raw) {
      if (isLocation(item)) {
        locations.push(item);
        continue;
      }
      if (
        typeof item === "object" &&
        item !== null &&
        "targetUri" in item &&
        "targetRange" in item
      ) {
        const obj = item as Record<string, unknown>;
        if (typeof obj.targetUri === "string" && isRange(obj.targetRange)) {
          locations.push({ uri: obj.targetUri, range: obj.targetRange as Range });
        }
      }
    }
    return locations;
  }
  if (isLocation(raw)) return [raw];
  return [];
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface LspMethods {
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
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createLspMethods(lifecycle: LspLifecycle): LspMethods {
  const { withConnection, openDocuments, diagnosticsCache } = lifecycle;

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

      const first = raw[0];
      if (first !== undefined && isDocumentSymbol(first)) {
        const validSymbols = raw.filter(isDocumentSymbol);
        const flat = flattenDocumentSymbols(validSymbols, uri);
        return limit !== undefined ? flat.slice(0, limit) : flat;
      }

      // SymbolInformation format
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
    // Guard against sending huge files to the LSP server (causes hangs/crashes)
    if (uri.startsWith("file://")) {
      const filePath = uri.replace(/^file:\/\//, "");
      try {
        const stat = await Bun.file(filePath).stat();
        if (stat.size > MAX_DOCUMENT_SIZE_BYTES) {
          return {
            ok: false,
            error: {
              code: "VALIDATION",
              message: `File too large for LSP: ${Math.ceil(stat.size / 1_000_000)}MB (max 10MB): ${filePath}`,
              retryable: false,
            },
          };
        }
      } catch {
        // File may not exist on disk yet (e.g., in-memory buffer) — skip size check
      }
    }

    const resolvedLanguageId = languageId ?? detectLanguageId(uri) ?? "plaintext";
    const existing = openDocuments.get(uri);
    const version = existing !== undefined ? existing.version + 1 : 1;

    openDocuments.set(uri, { uri, languageId: resolvedLanguageId, content, version });

    return withConnection(async (conn) => {
      if (existing !== undefined) {
        conn.sendNotification("textDocument/didClose", { textDocument: { uri } });
      }
      conn.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId: resolvedLanguageId, version, text: content },
      });
    });
  };

  const closeDocument = async (uri: string): Promise<Result<void, KoiError>> => {
    openDocuments.delete(uri);
    diagnosticsCache.delete(uri);

    return withConnection(async (conn) => {
      conn.sendNotification("textDocument/didClose", { textDocument: { uri } });
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

  const capabilities = (): import("./types.js").ServerCapabilities | undefined =>
    lifecycle.capabilities();

  return {
    hover,
    gotoDefinition,
    findReferences,
    documentSymbols,
    workspaceSymbols,
    openDocument,
    closeDocument,
    getDiagnostics,
    capabilities,
  };
}
