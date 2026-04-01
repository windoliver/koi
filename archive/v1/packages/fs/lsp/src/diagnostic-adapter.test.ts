import { describe, expect, mock, test } from "bun:test";
import type { LspClient } from "./client.js";
import { createLspDiagnosticProvider } from "./diagnostic-adapter.js";
import type { Diagnostic } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockClient(diagnostics: readonly Diagnostic[] = []): LspClient {
  const diagMap = new Map<string, readonly Diagnostic[]>();
  return {
    connect: mock(async () => ({ ok: true as const, value: undefined })),
    hover: mock(async () => ({ ok: true as const, value: null })),
    gotoDefinition: mock(async () => ({ ok: true as const, value: [] })),
    findReferences: mock(async () => ({ ok: true as const, value: [] })),
    documentSymbols: mock(async () => ({ ok: true as const, value: [] })),
    workspaceSymbols: mock(async () => ({ ok: true as const, value: [] })),
    openDocument: mock(async (uri: string) => {
      diagMap.set(uri, diagnostics);
      return { ok: true as const, value: undefined };
    }),
    closeDocument: mock(async () => ({ ok: true as const, value: undefined })),
    getDiagnostics: mock((uri?: string) => {
      if (uri !== undefined) {
        const result = new Map<string, readonly Diagnostic[]>();
        const items = diagMap.get(uri);
        if (items !== undefined) {
          result.set(uri, items);
        }
        return result;
      }
      return diagMap;
    }),
    capabilities: mock(() => undefined),
    close: mock(async () => {}),
    isConnected: mock(() => true),
    serverName: mock(() => "test-server"),
  } as unknown as LspClient;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createLspDiagnosticProvider", () => {
  test("returns provider with lsp: prefixed name", () => {
    const client = createMockClient();
    const provider = createLspDiagnosticProvider(client, "typescript");
    expect(provider.name).toBe("lsp:typescript");
  });

  test("returns empty diagnostics when no issues", async () => {
    const client = createMockClient([]);
    const provider = createLspDiagnosticProvider(client, "ts");
    const items = await provider.diagnose("file:///test.ts", "const x = 1;");
    expect(items).toHaveLength(0);
  });

  test("maps LSP severity 1 to error", async () => {
    const diag: Diagnostic = {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      severity: 1,
      message: "Type error",
      source: "typescript",
    };
    const client = createMockClient([diag]);
    const provider = createLspDiagnosticProvider(client, "ts");
    const items = await provider.diagnose("file:///test.ts", "const x = 1;");
    expect(items).toHaveLength(1);
    expect(items[0]?.severity).toBe("error");
    expect(items[0]?.message).toBe("Type error");
    expect(items[0]?.source).toBe("typescript");
  });

  test("maps LSP severity 2 to warning", async () => {
    const diag: Diagnostic = {
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 10 } },
      severity: 2,
      message: "Unused variable",
    };
    const client = createMockClient([diag]);
    const provider = createLspDiagnosticProvider(client, "ts");
    const items = await provider.diagnose("file:///test.ts", "const x = 1;");
    expect(items).toHaveLength(1);
    expect(items[0]?.severity).toBe("warning");
  });

  test("maps LSP severity 3 to info and 4 to hint", async () => {
    const diags: readonly Diagnostic[] = [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        severity: 3,
        message: "Info",
      },
      {
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
        severity: 4,
        message: "Hint",
      },
    ];
    const client = createMockClient(diags);
    const provider = createLspDiagnosticProvider(client, "ts");
    const items = await provider.diagnose("file:///test.ts", "const x = 1;");
    expect(items).toHaveLength(2);
    expect(items[0]?.severity).toBe("info");
    expect(items[1]?.severity).toBe("hint");
  });

  test("includes diagnostic code when present", async () => {
    const diag: Diagnostic = {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      severity: 1,
      message: "Error",
      code: 2322,
    };
    const client = createMockClient([diag]);
    const provider = createLspDiagnosticProvider(client, "ts");
    const items = await provider.diagnose("file:///test.ts", "code");
    expect(items[0]?.code).toBe(2322);
  });

  test("returns empty when openDocument fails", async () => {
    const client = createMockClient();
    (client.openDocument as ReturnType<typeof mock>).mockImplementation(async () => ({
      ok: false as const,
      error: { code: "INTERNAL", message: "fail", retryable: false },
    }));
    const provider = createLspDiagnosticProvider(client, "ts");
    const items = await provider.diagnose("file:///test.ts", "code");
    expect(items).toHaveLength(0);
  });

  test("dispose closes the client", () => {
    const client = createMockClient();
    const provider = createLspDiagnosticProvider(client, "ts");
    provider.dispose?.();
    expect(client.close).toHaveBeenCalled();
  });
});
