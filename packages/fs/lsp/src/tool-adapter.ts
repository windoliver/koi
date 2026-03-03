/**
 * Tool adapter — creates Koi Tool components from LSP client capabilities.
 *
 * Tools are namespaced as `lsp/{serverName}/{operation}` to avoid collisions.
 * Tools are capability-gated: only created if the server advertises support.
 */

import type { JsonObject, Tool, ToolDescriptor } from "@koi/core";
import type { LspClient } from "./client.js";
import type { ServerCapabilities } from "./types.js";

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

const OPEN_DOCUMENT_SCHEMA: JsonObject = {
  type: "object",
  properties: {
    uri: { type: "string", description: "File URI (e.g. file:///path/to/file.ts)" },
    content: { type: "string", description: "Full file content" },
    languageId: { type: "string", description: "Language identifier (auto-detected if omitted)" },
  },
  required: ["uri", "content"],
};

const CLOSE_DOCUMENT_SCHEMA: JsonObject = {
  type: "object",
  properties: {
    uri: { type: "string", description: "File URI to close" },
  },
  required: ["uri"],
};

const POSITION_SCHEMA: JsonObject = {
  type: "object",
  properties: {
    uri: { type: "string", description: "File URI" },
    line: { type: "number", description: "Zero-based line number" },
    character: { type: "number", description: "Zero-based character offset" },
  },
  required: ["uri", "line", "character"],
};

const REFERENCES_SCHEMA: JsonObject = {
  type: "object",
  properties: {
    uri: { type: "string", description: "File URI" },
    line: { type: "number", description: "Zero-based line number" },
    character: { type: "number", description: "Zero-based character offset" },
    limit: { type: "number", description: "Maximum number of references to return" },
  },
  required: ["uri", "line", "character"],
};

const DOCUMENT_SYMBOLS_SCHEMA: JsonObject = {
  type: "object",
  properties: {
    uri: { type: "string", description: "File URI" },
    limit: { type: "number", description: "Maximum number of symbols to return" },
  },
  required: ["uri"],
};

const WORKSPACE_SYMBOLS_SCHEMA: JsonObject = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query for symbol names" },
    limit: { type: "number", description: "Maximum number of symbols to return" },
  },
  required: ["query"],
};

const GET_DIAGNOSTICS_SCHEMA: JsonObject = {
  type: "object",
  properties: {
    uri: {
      type: "string",
      description: "File URI to get diagnostics for (returns all if omitted)",
    },
  },
};

// ---------------------------------------------------------------------------
// Argument extraction helpers (runtime validation at tool boundary)
// ---------------------------------------------------------------------------

const INVALID_ARGS = {
  ok: false,
  error: { code: "VALIDATION", message: "Invalid tool arguments" },
} as const;

interface PositionArgs {
  readonly uri: string;
  readonly line: number;
  readonly character: number;
}

function extractPositionArgs(args: JsonObject): PositionArgs | undefined {
  if (
    typeof args.uri !== "string" ||
    typeof args.line !== "number" ||
    typeof args.character !== "number"
  ) {
    return undefined;
  }
  return { uri: args.uri, line: args.line, character: args.character };
}

function extractString(args: JsonObject, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

// ---------------------------------------------------------------------------
// Tool factory helpers
// ---------------------------------------------------------------------------

function createTool(
  serverName: string,
  operation: string,
  description: string,
  inputSchema: JsonObject,
  execute: (args: JsonObject) => Promise<unknown>,
): Tool {
  const descriptor: ToolDescriptor = {
    name: `lsp/${serverName}/${operation}`,
    description,
    inputSchema,
  };

  return {
    descriptor,
    trustTier: "promoted",
    execute,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Creates Koi Tool components from an LSP client.
 *
 * Always includes open_document and close_document tools.
 * Other tools are only created if the server advertises the capability.
 */
export function createLspTools(
  client: LspClient,
  serverName: string,
  maxReferences: number = 100,
  maxSymbols: number = 50,
): readonly Tool[] {
  const caps = client.capabilities();
  const tools: Tool[] = [];

  // Always available: document lifecycle
  tools.push(
    createTool(
      serverName,
      "open_document",
      `Open a document in LSP server "${serverName}" for analysis. Must be called before hover/definition/references.`,
      OPEN_DOCUMENT_SCHEMA,
      async (args) => {
        const uri = extractString(args, "uri");
        const content = extractString(args, "content");
        if (uri === undefined || content === undefined) return INVALID_ARGS;
        const langId = extractString(args, "languageId");
        const result = await client.openDocument(uri, content, langId);
        if (!result.ok)
          return { ok: false, error: { code: result.error.code, message: result.error.message } };
        return { ok: true, message: "Document opened" };
      },
    ),
  );

  tools.push(
    createTool(
      serverName,
      "close_document",
      `Close a previously opened document in LSP server "${serverName}".`,
      CLOSE_DOCUMENT_SCHEMA,
      async (args) => {
        const uri = extractString(args, "uri");
        if (uri === undefined) return INVALID_ARGS;
        const result = await client.closeDocument(uri);
        if (!result.ok)
          return { ok: false, error: { code: result.error.code, message: result.error.message } };
        return { ok: true, message: "Document closed" };
      },
    ),
  );

  // Always available: diagnostics (all LSP servers emit publishDiagnostics)
  tools.push(
    createTool(
      serverName,
      "get_diagnostics",
      `Get cached diagnostics (compiler errors, warnings, lints) from LSP server "${serverName}". Returns all diagnostics if no URI specified.`,
      GET_DIAGNOSTICS_SCHEMA,
      async (args) => {
        const uri = extractString(args, "uri");
        const diags = client.getDiagnostics(uri);
        const entries: { readonly uri: string; readonly diagnostics: readonly unknown[] }[] = [];
        for (const [diagUri, diagnostics] of diags) {
          entries.push({ uri: diagUri, diagnostics });
        }
        return entries;
      },
    ),
  );

  // Capability-gated tools
  if (hasCapability(caps, "hoverProvider")) {
    tools.push(
      createTool(
        serverName,
        "hover",
        `Get hover information (type, documentation) for a symbol at a position in LSP server "${serverName}".`,
        POSITION_SCHEMA,
        async (args) => {
          const pos = extractPositionArgs(args);
          if (pos === undefined) return INVALID_ARGS;
          const result = await client.hover(pos.uri, pos.line, pos.character);
          if (!result.ok)
            return { ok: false, error: { code: result.error.code, message: result.error.message } };
          return result.value;
        },
      ),
    );
  }

  if (hasCapability(caps, "definitionProvider")) {
    tools.push(
      createTool(
        serverName,
        "goto_definition",
        `Find the definition location of a symbol at a position in LSP server "${serverName}".`,
        POSITION_SCHEMA,
        async (args) => {
          const pos = extractPositionArgs(args);
          if (pos === undefined) return INVALID_ARGS;
          const result = await client.gotoDefinition(pos.uri, pos.line, pos.character);
          if (!result.ok)
            return { ok: false, error: { code: result.error.code, message: result.error.message } };
          return result.value;
        },
      ),
    );
  }

  if (hasCapability(caps, "referencesProvider")) {
    tools.push(
      createTool(
        serverName,
        "find_references",
        `Find all references to a symbol at a position in LSP server "${serverName}". Returns up to ${maxReferences} results.`,
        REFERENCES_SCHEMA,
        async (args) => {
          const pos = extractPositionArgs(args);
          if (pos === undefined) return INVALID_ARGS;
          const limit =
            typeof args.limit === "number" ? Math.min(args.limit, maxReferences) : maxReferences;
          const result = await client.findReferences(pos.uri, pos.line, pos.character, limit);
          if (!result.ok)
            return { ok: false, error: { code: result.error.code, message: result.error.message } };
          return result.value;
        },
      ),
    );
  }

  if (hasCapability(caps, "documentSymbolProvider")) {
    tools.push(
      createTool(
        serverName,
        "document_symbols",
        `List all symbols (functions, classes, variables) in a document in LSP server "${serverName}". Returns up to ${maxSymbols} results.`,
        DOCUMENT_SYMBOLS_SCHEMA,
        async (args) => {
          const uri = extractString(args, "uri");
          if (uri === undefined) return INVALID_ARGS;
          const limit =
            typeof args.limit === "number" ? Math.min(args.limit, maxSymbols) : maxSymbols;
          const result = await client.documentSymbols(uri, limit);
          if (!result.ok)
            return { ok: false, error: { code: result.error.code, message: result.error.message } };
          return result.value;
        },
      ),
    );
  }

  if (hasCapability(caps, "workspaceSymbolProvider")) {
    tools.push(
      createTool(
        serverName,
        "workspace_symbols",
        `Search for symbols across the workspace in LSP server "${serverName}". Returns up to ${maxSymbols} results.`,
        WORKSPACE_SYMBOLS_SCHEMA,
        async (args) => {
          const query = extractString(args, "query");
          if (query === undefined) return INVALID_ARGS;
          const limit =
            typeof args.limit === "number" ? Math.min(args.limit, maxSymbols) : maxSymbols;
          const result = await client.workspaceSymbols(query, limit);
          if (!result.ok)
            return { ok: false, error: { code: result.error.code, message: result.error.message } };
          return result.value;
        },
      ),
    );
  }

  return tools;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasCapability(
  caps: ServerCapabilities | undefined,
  key: keyof ServerCapabilities,
): boolean {
  if (caps === undefined) return false;
  const value = caps[key];
  return value !== undefined && value !== false;
}
