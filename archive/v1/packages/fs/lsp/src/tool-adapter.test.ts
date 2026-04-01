import { describe, expect, test } from "bun:test";
import type { LspClient } from "./client.js";
import { createLspTools } from "./tool-adapter.js";
import type { Diagnostic, HoverResult, Location, ServerCapabilities, SymbolInfo } from "./types.js";

// ---------------------------------------------------------------------------
// Mock LspClient factory
// ---------------------------------------------------------------------------

interface MockClientOptions {
  readonly capabilities?: ServerCapabilities;
  readonly hoverResult?: HoverResult | null;
  readonly definitionResult?: readonly Location[];
  readonly referencesResult?: readonly Location[];
  readonly documentSymbolsResult?: readonly SymbolInfo[];
  readonly workspaceSymbolsResult?: readonly SymbolInfo[];
  readonly diagnostics?: ReadonlyMap<string, readonly Diagnostic[]>;
}

function createMockClient(options: MockClientOptions = {}): LspClient {
  const caps = options.capabilities ?? {
    hoverProvider: true,
    definitionProvider: true,
    referencesProvider: true,
    documentSymbolProvider: true,
    workspaceSymbolProvider: true,
  };

  return {
    connect: async () => ({ ok: true, value: undefined }),
    hover: async () => ({ ok: true, value: options.hoverResult ?? null }),
    gotoDefinition: async () => ({
      ok: true,
      value: options.definitionResult ?? [],
    }),
    findReferences: async (_u, _l, _c, limit) => {
      const refs = options.referencesResult ?? [];
      return { ok: true, value: limit !== undefined ? refs.slice(0, limit) : refs };
    },
    documentSymbols: async (_u, limit) => {
      const syms = options.documentSymbolsResult ?? [];
      return { ok: true, value: limit !== undefined ? syms.slice(0, limit) : syms };
    },
    workspaceSymbols: async (_q, limit) => {
      const syms = options.workspaceSymbolsResult ?? [];
      return { ok: true, value: limit !== undefined ? syms.slice(0, limit) : syms };
    },
    openDocument: async () => ({ ok: true, value: undefined }),
    closeDocument: async () => ({ ok: true, value: undefined }),
    getDiagnostics: (uri) => {
      const all = options.diagnostics ?? new Map();
      if (uri !== undefined) {
        const diags = all.get(uri);
        if (diags === undefined) return new Map();
        return new Map([[uri, diags]]);
      }
      return new Map(all);
    },
    capabilities: () => caps,
    close: async () => {},
    isConnected: () => true,
    serverName: () => "test-server",
  };
}

// ---------------------------------------------------------------------------
// createLspTools
// ---------------------------------------------------------------------------

describe("createLspTools", () => {
  test("creates all 8 tools when all capabilities present", () => {
    const client = createMockClient();
    const tools = createLspTools(client, "ts-server");

    expect(tools).toHaveLength(8);

    const names = tools.map((t) => t.descriptor.name);
    expect(names).toContain("lsp/ts-server/open_document");
    expect(names).toContain("lsp/ts-server/close_document");
    expect(names).toContain("lsp/ts-server/get_diagnostics");
    expect(names).toContain("lsp/ts-server/hover");
    expect(names).toContain("lsp/ts-server/goto_definition");
    expect(names).toContain("lsp/ts-server/find_references");
    expect(names).toContain("lsp/ts-server/document_symbols");
    expect(names).toContain("lsp/ts-server/workspace_symbols");
  });

  test("creates document + diagnostics tools when no capabilities", () => {
    const client = createMockClient({ capabilities: {} });
    const tools = createLspTools(client, "minimal-server");

    expect(tools).toHaveLength(3);
    const names = tools.map((t) => t.descriptor.name);
    expect(names).toContain("lsp/minimal-server/open_document");
    expect(names).toContain("lsp/minimal-server/close_document");
    expect(names).toContain("lsp/minimal-server/get_diagnostics");
  });

  test("skips hover when hoverProvider is false", () => {
    const client = createMockClient({
      capabilities: { hoverProvider: false, definitionProvider: true },
    });
    const tools = createLspTools(client, "srv");

    const names = tools.map((t) => t.descriptor.name);
    expect(names).not.toContain("lsp/srv/hover");
    expect(names).toContain("lsp/srv/goto_definition");
  });

  test("all tools have promoted trust tier", () => {
    const client = createMockClient();
    const tools = createLspTools(client, "srv");

    for (const tool of tools) {
      expect(tool.policy.sandbox).toBe(false);
    }
  });

  test("hover tool executes and returns result", async () => {
    const client = createMockClient({
      hoverResult: { contents: { kind: "markdown", value: "**type info**" } },
    });
    const tools = createLspTools(client, "srv");
    const hoverTool = tools.find((t) => t.descriptor.name === "lsp/srv/hover");

    const result = await hoverTool?.execute({
      uri: "file:///test.ts",
      line: 5,
      character: 10,
    });
    expect(result).toEqual({ contents: { kind: "markdown", value: "**type info**" } });
  });

  test("goto_definition tool executes and returns locations", async () => {
    const loc: Location = {
      uri: "file:///def.ts",
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
    };
    const client = createMockClient({ definitionResult: [loc] });
    const tools = createLspTools(client, "srv");
    const defTool = tools.find((t) => t.descriptor.name === "lsp/srv/goto_definition");

    const result = await defTool?.execute({
      uri: "file:///test.ts",
      line: 3,
      character: 7,
    });
    expect(result).toEqual([loc]);
  });

  test("find_references enforces max limit", async () => {
    const refs: readonly Location[] = Array.from({ length: 200 }, (_, i) => ({
      uri: `file:///ref${i}.ts`,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
    }));
    const client = createMockClient({ referencesResult: refs });
    const tools = createLspTools(client, "srv", 50, 50);
    const refTool = tools.find((t) => t.descriptor.name === "lsp/srv/find_references");

    // Request 200, but max is 50
    const result = (await refTool?.execute({
      uri: "file:///test.ts",
      line: 0,
      character: 0,
      limit: 200,
    })) as readonly Location[];

    expect(result).toHaveLength(50);
  });

  test("open_document tool returns success", async () => {
    const client = createMockClient();
    const tools = createLspTools(client, "srv");
    const openTool = tools.find((t) => t.descriptor.name === "lsp/srv/open_document");

    const result = await openTool?.execute({
      uri: "file:///test.ts",
      content: "const x = 1;",
    });
    expect(result).toEqual({ ok: true, message: "Document opened" });
  });

  test("close_document tool returns success", async () => {
    const client = createMockClient();
    const tools = createLspTools(client, "srv");
    const closeTool = tools.find((t) => t.descriptor.name === "lsp/srv/close_document");

    const result = await closeTool?.execute({
      uri: "file:///test.ts",
    });
    expect(result).toEqual({ ok: true, message: "Document closed" });
  });

  test("get_diagnostics tool is always created", () => {
    const client = createMockClient({ capabilities: {} });
    const tools = createLspTools(client, "srv");
    const diagTool = tools.find((t) => t.descriptor.name === "lsp/srv/get_diagnostics");
    expect(diagTool).toBeDefined();
    expect(diagTool?.policy.sandbox).toBe(false);
  });

  test("get_diagnostics tool returns cached diagnostics", async () => {
    const diags: ReadonlyMap<string, readonly Diagnostic[]> = new Map([
      [
        "file:///test.ts",
        [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
            severity: 1 as const,
            message: "Type error",
            source: "typescript",
          },
        ],
      ],
    ]);
    const client = createMockClient({ diagnostics: diags });
    const tools = createLspTools(client, "srv");
    const diagTool = tools.find((t) => t.descriptor.name === "lsp/srv/get_diagnostics");

    const result = await diagTool?.execute({});
    expect(result).toEqual([
      {
        uri: "file:///test.ts",
        diagnostics: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
            severity: 1,
            message: "Type error",
            source: "typescript",
          },
        ],
      },
    ]);
  });

  test("get_diagnostics tool filters by URI", async () => {
    const diags: ReadonlyMap<string, readonly Diagnostic[]> = new Map([
      [
        "file:///a.ts",
        [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            message: "error a",
          },
        ],
      ],
      [
        "file:///b.ts",
        [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            message: "error b",
          },
        ],
      ],
    ]);
    const client = createMockClient({ diagnostics: diags });
    const tools = createLspTools(client, "srv");
    const diagTool = tools.find((t) => t.descriptor.name === "lsp/srv/get_diagnostics");

    const result = (await diagTool?.execute({ uri: "file:///a.ts" })) as readonly {
      readonly uri: string;
    }[];
    expect(result).toHaveLength(1);
    expect(result[0]?.uri).toBe("file:///a.ts");
  });
});
