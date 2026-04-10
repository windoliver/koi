import { describe, expect, test } from "bun:test";
import type { CreateTransportFn } from "./client.js";
import { createLspClient } from "./client.js";
import type { ResolvedLspServerConfig } from "./config.js";
import type { JsonRpcMessage, JsonRpcRequest, JsonRpcResponse } from "./jsonrpc.js";
import { createMessageParser } from "./jsonrpc.js";
import type { LspTransport } from "./transport.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_CONFIG: ResolvedLspServerConfig = {
  name: "test-server",
  command: "test-lsp",
  args: [],
  env: {},
  rootUri: "file:///project",
  languageId: undefined,
  initializationOptions: undefined,
  timeoutMs: 30_000,
};

function encodeMessage(message: JsonRpcMessage): Uint8Array {
  const body = JSON.stringify(message);
  const header = `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n`;
  return Buffer.from(header + body);
}

interface MockTransportOptions {
  readonly capabilities?: object;
  readonly responses?: ReadonlyMap<string, unknown>;
}

/**
 * Creates a mock transport using Bun-native streams (ReadableStream + FileSink).
 *
 * The mock server auto-responds to initialize and other requests.
 */
function createMockTransportFactory(options: MockTransportOptions = {}): {
  readonly factory: CreateTransportFn;
  /** Inject a raw message into the stream the client reads from. */
  readonly sendToClient: (msg: JsonRpcMessage) => void;
} {
  // let is justified: mutable ref to latest stream controller
  let clientController: ReadableStreamDefaultController<Uint8Array> | undefined;

  // Use real createMessageParser to avoid re-implementing the protocol
  const parser = createMessageParser((msg) => {
    if (!("id" in msg) || !("method" in msg)) return; // skip non-requests
    const req = msg as JsonRpcRequest;
    // let is justified: response varies by method
    let result: unknown = null;
    if (req.method === "initialize") {
      result = {
        capabilities: options.capabilities ?? {
          hoverProvider: true,
          definitionProvider: true,
          referencesProvider: true,
          documentSymbolProvider: true,
          workspaceSymbolProvider: true,
        },
      };
    } else if (req.method === "shutdown") {
      result = null;
    } else if (options.responses !== undefined) {
      result = options.responses.get(req.method) ?? null;
    }
    const response: JsonRpcResponse = { jsonrpc: "2.0", id: req.id, result };
    clientController?.enqueue(encodeMessage(response));
  });

  const factory: CreateTransportFn = (): LspTransport => {
    const stdout = new ReadableStream<Uint8Array>({
      start(c) {
        clientController = c;
      },
    });

    // let is justified: tracks process exit state
    let exited = false;
    // let is justified: mutable resolve for exited promise
    let resolveExited: (code: number) => void = () => {};
    const exitedPromise = new Promise<number>((resolve) => {
      resolveExited = resolve;
    });

    const stdin = {
      write: (data: Uint8Array) => {
        parser(data);
      },
      flush: () => {},
    } as unknown as import("bun").FileSink;

    const dispose = (): void => {
      if (!exited) {
        exited = true;
        clientController?.close();
        resolveExited(0);
      }
    };

    return {
      stdin,
      stdout,
      exited: exitedPromise,
      dispose,
    };
  };

  const sendToClient = (msg: JsonRpcMessage): void => {
    clientController?.enqueue(encodeMessage(msg));
  };

  return { factory, sendToClient };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createLspClient", () => {
  test("connect performs initialize handshake", async () => {
    const { factory } = createMockTransportFactory();
    const client = createLspClient(TEST_CONFIG, 2, 5_000, factory);

    const result = await client.connect();
    expect(result.ok).toBe(true);
    expect(client.isConnected()).toBe(true);
    expect(client.serverName()).toBe("test-server");
    expect(client.capabilities()).toBeDefined();
    expect(client.capabilities()?.hoverProvider).toBe(true);

    await client.close();
  });

  test("connect is idempotent when already connected", async () => {
    const { factory } = createMockTransportFactory();
    const client = createLspClient(TEST_CONFIG, 2, 5_000, factory);

    await client.connect();
    const result = await client.connect();
    expect(result.ok).toBe(true);

    await client.close();
  });

  test("connect returns timeout error on slow server", async () => {
    // Factory that never responds to initialize
    const factory: CreateTransportFn = (): LspTransport => {
      const stdout = new ReadableStream<Uint8Array>({ start: () => {} });
      const stdin = {
        write: (_d: Uint8Array) => {},
        flush: () => {},
      } as unknown as import("bun").FileSink;
      const exited = new Promise<number>(() => {});
      return { stdin, stdout, exited, dispose: () => {} };
    };

    const client = createLspClient(TEST_CONFIG, 0, 100, factory);
    const result = await client.connect();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
    }
  });

  test("hover returns result from server", async () => {
    const responses = new Map<string, unknown>([
      ["textDocument/hover", { contents: { kind: "markdown", value: "**hover info**" } }],
    ]);
    const { factory } = createMockTransportFactory({ responses });
    const client = createLspClient(TEST_CONFIG, 2, 5_000, factory);

    await client.connect();

    const result = await client.hover("file:///test.ts", 10, 5);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        contents: { kind: "markdown", value: "**hover info**" },
      });
    }

    await client.close();
  });

  test("hover returns null when server returns null", async () => {
    const responses = new Map<string, unknown>([["textDocument/hover", null]]);
    const { factory } = createMockTransportFactory({ responses });
    const client = createLspClient(TEST_CONFIG, 2, 5_000, factory);

    await client.connect();
    const result = await client.hover("file:///test.ts", 0, 0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeNull();
    }

    await client.close();
  });

  test("gotoDefinition normalizes single location", async () => {
    const responses = new Map<string, unknown>([
      [
        "textDocument/definition",
        {
          uri: "file:///def.ts",
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 10 } },
        },
      ],
    ]);
    const { factory } = createMockTransportFactory({ responses });
    const client = createLspClient(TEST_CONFIG, 2, 5_000, factory);

    await client.connect();
    const result = await client.gotoDefinition("file:///test.ts", 5, 3);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.uri).toBe("file:///def.ts");
    }

    await client.close();
  });

  test("findReferences respects limit", async () => {
    const refs = Array.from({ length: 10 }, (_, i) => ({
      uri: `file:///ref${i}.ts`,
      range: { start: { line: i, character: 0 }, end: { line: i, character: 5 } },
    }));
    const responses = new Map<string, unknown>([["textDocument/references", refs]]);
    const { factory } = createMockTransportFactory({ responses });
    const client = createLspClient(TEST_CONFIG, 2, 5_000, factory);

    await client.connect();
    const result = await client.findReferences("file:///test.ts", 1, 1, 3);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(3);
    }

    await client.close();
  });

  test("documentSymbols flattens hierarchical symbols", async () => {
    const responses = new Map<string, unknown>([
      [
        "textDocument/documentSymbol",
        [
          {
            name: "MyClass",
            kind: 5,
            range: { start: { line: 0, character: 0 }, end: { line: 10, character: 1 } },
            selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } },
            children: [
              {
                name: "myMethod",
                kind: 6,
                range: { start: { line: 2, character: 2 }, end: { line: 5, character: 3 } },
                selectionRange: {
                  start: { line: 2, character: 2 },
                  end: { line: 2, character: 10 },
                },
              },
            ],
          },
        ],
      ],
    ]);
    const { factory } = createMockTransportFactory({ responses });
    const client = createLspClient(TEST_CONFIG, 2, 5_000, factory);

    await client.connect();
    const result = await client.documentSymbols("file:///test.ts");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
      expect(result.value[0]?.name).toBe("MyClass");
      expect(result.value[1]?.name).toBe("myMethod");
      expect(result.value[1]?.containerName).toBe("MyClass");
    }

    await client.close();
  });

  test("workspaceSymbols applies limit", async () => {
    const syms = Array.from({ length: 20 }, (_, i) => ({
      name: `sym${i}`,
      kind: 12,
      location: {
        uri: `file:///src/file${i}.ts`,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      },
    }));
    const responses = new Map<string, unknown>([["workspace/symbol", syms]]);
    const { factory } = createMockTransportFactory({ responses });
    const client = createLspClient(TEST_CONFIG, 2, 5_000, factory);

    await client.connect();
    const result = await client.workspaceSymbols("sym", 5);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(5);
    }

    await client.close();
  });

  test("openDocument tracks document and sends notification", async () => {
    const { factory } = createMockTransportFactory();
    const client = createLspClient(TEST_CONFIG, 2, 5_000, factory);

    await client.connect();
    const result = await client.openDocument("file:///test.ts", "const x = 1;", "typescript");
    expect(result.ok).toBe(true);

    await client.close();
  });

  test("closeDocument removes tracked document", async () => {
    const { factory } = createMockTransportFactory();
    const client = createLspClient(TEST_CONFIG, 2, 5_000, factory);

    await client.connect();
    await client.openDocument("file:///test.ts", "const x = 1;");
    const result = await client.closeDocument("file:///test.ts");
    expect(result.ok).toBe(true);

    await client.close();
  });

  test("methods return not-connected error when not connected", async () => {
    const { factory } = createMockTransportFactory();
    const client = createLspClient(TEST_CONFIG, 2, 5_000, factory);

    const result = await client.hover("file:///test.ts", 0, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("not connected");
    }
  });

  test("close is idempotent", async () => {
    const { factory } = createMockTransportFactory();
    const client = createLspClient(TEST_CONFIG, 2, 5_000, factory);

    await client.connect();
    await client.close();
    await client.close();

    expect(client.isConnected()).toBe(false);
  });

  test("capabilities returns undefined before connect", () => {
    const { factory } = createMockTransportFactory();
    const client = createLspClient(TEST_CONFIG, 2, 5_000, factory);
    expect(client.capabilities()).toBeUndefined();
  });

  test("gotoDefinition normalizes LocationLink array", async () => {
    const responses = new Map<string, unknown>([
      [
        "textDocument/definition",
        [
          {
            targetUri: "file:///link.ts",
            targetRange: { start: { line: 5, character: 0 }, end: { line: 5, character: 10 } },
            targetSelectionRange: {
              start: { line: 5, character: 0 },
              end: { line: 5, character: 5 },
            },
          },
        ],
      ],
    ]);
    const { factory } = createMockTransportFactory({ responses });
    const client = createLspClient(TEST_CONFIG, 2, 5_000, factory);

    await client.connect();
    const result = await client.gotoDefinition("file:///test.ts", 1, 0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.uri).toBe("file:///link.ts");
    }

    await client.close();
  });

  test("gotoDefinition returns empty for null response", async () => {
    const responses = new Map<string, unknown>([["textDocument/definition", null]]);
    const { factory } = createMockTransportFactory({ responses });
    const client = createLspClient(TEST_CONFIG, 2, 5_000, factory);

    await client.connect();
    const result = await client.gotoDefinition("file:///test.ts", 1, 0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(0);
    }

    await client.close();
  });

  test("documentSymbols handles SymbolInformation format", async () => {
    const responses = new Map<string, unknown>([
      [
        "textDocument/documentSymbol",
        [
          {
            name: "myFunc",
            kind: 12,
            location: {
              uri: "file:///test.ts",
              range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } },
            },
            containerName: "module",
          },
        ],
      ],
    ]);
    const { factory } = createMockTransportFactory({ responses });
    const client = createLspClient(TEST_CONFIG, 2, 5_000, factory);

    await client.connect();
    const result = await client.documentSymbols("file:///test.ts");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.name).toBe("myFunc");
      expect(result.value[0]?.containerName).toBe("module");
    }

    await client.close();
  });

  test("connect returns error when transport creation throws", async () => {
    const factory: CreateTransportFn = () => {
      throw new Error("Command not found: nonexistent-lsp");
    };

    const client = createLspClient(TEST_CONFIG, 0, 5_000, factory);
    const result = await client.connect();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
    }
  });

  // -----------------------------------------------------------------------
  // Diagnostics
  // -----------------------------------------------------------------------

  test("getDiagnostics returns empty map when no diagnostics received", async () => {
    const { factory } = createMockTransportFactory();
    const client = createLspClient(TEST_CONFIG, 2, 5_000, factory);
    await client.connect();

    const diags = client.getDiagnostics();
    expect(diags.size).toBe(0);

    await client.close();
  });

  test("getDiagnostics caches diagnostics from publishDiagnostics notification", async () => {
    const { factory, sendToClient } = createMockTransportFactory();
    const client = createLspClient(TEST_CONFIG, 2, 5_000, factory);
    await client.connect();

    sendToClient({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
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
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const diags = client.getDiagnostics("file:///test.ts");
    expect(diags.size).toBe(1);
    const fileDiags = diags.get("file:///test.ts");
    expect(fileDiags).toHaveLength(1);
    expect(fileDiags?.[0]?.message).toBe("Type error");

    await client.close();
  });

  test("getDiagnostics without URI returns all cached diagnostics", async () => {
    const { factory, sendToClient } = createMockTransportFactory();
    const client = createLspClient(TEST_CONFIG, 2, 5_000, factory);
    await client.connect();

    for (const uri of ["file:///a.ts", "file:///b.ts"]) {
      sendToClient({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: {
          uri,
          diagnostics: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
              message: `error in ${uri}`,
            },
          ],
        },
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 50));

    const all = client.getDiagnostics();
    expect(all.size).toBe(2);
    expect(all.has("file:///a.ts")).toBe(true);
    expect(all.has("file:///b.ts")).toBe(true);

    await client.close();
  });

  test("closeDocument clears diagnostics for that URI", async () => {
    const { factory, sendToClient } = createMockTransportFactory();
    const client = createLspClient(TEST_CONFIG, 2, 5_000, factory);
    await client.connect();

    await client.openDocument("file:///test.ts", "const x = 1;");

    sendToClient({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: "file:///test.ts",
        diagnostics: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            message: "error",
          },
        ],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(client.getDiagnostics("file:///test.ts").size).toBe(1);

    await client.closeDocument("file:///test.ts");
    expect(client.getDiagnostics("file:///test.ts").size).toBe(0);

    await client.close();
  });

  // -----------------------------------------------------------------------
  // Reconnect tests
  // -----------------------------------------------------------------------

  test("non-connection error (JSON-RPC error) does not trigger reconnect", async () => {
    // let is justified: count transport creations
    let transportCount = 0;
    const factory: CreateTransportFn = (): LspTransport => {
      transportCount++;
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      const stdout = new ReadableStream<Uint8Array>({
        start: (c) => {
          controller = c;
        },
      });
      const parser = createMessageParser((msg) => {
        if (!("id" in msg) || !("method" in msg)) return;
        const req = msg as JsonRpcRequest;
        let result: unknown = null;
        if (req.method === "initialize") {
          result = { capabilities: { hoverProvider: true } };
        } else if (req.method === "textDocument/hover") {
          // Non-connection error — should NOT trigger reconnect
          const resp: JsonRpcResponse = {
            jsonrpc: "2.0",
            id: req.id,
            error: { code: -32601, message: "Method not found" },
          };
          controller?.enqueue(encodeMessage(resp));
          return;
        } else if (req.method === "shutdown") {
          result = null;
        }
        controller?.enqueue(encodeMessage({ jsonrpc: "2.0", id: req.id, result }));
      });
      const stdin = {
        write: (d: Uint8Array) => {
          parser(d);
        },
        flush: () => {},
      } as unknown as import("bun").FileSink;
      return { stdin, stdout, exited: new Promise(() => {}), dispose: () => {} };
    };

    const client = createLspClient(TEST_CONFIG, 2, 5_000, factory);
    await client.connect();
    expect(transportCount).toBe(1);

    const result = await client.hover("file:///test.ts", 0, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Method not found");
    }
    // Transport count should still be 1 — no reconnect triggered
    expect(transportCount).toBe(1);

    await client.close();
  });

  test("reconnects after EPIPE and retries the operation", async () => {
    // let is justified: count transport creations
    let transportCount = 0;
    let firstController: ReadableStreamDefaultController<Uint8Array> | undefined;

    const factory: CreateTransportFn = (): LspTransport => {
      transportCount++;
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      const stdout = new ReadableStream<Uint8Array>({
        start: (c) => {
          controller = c;
          if (transportCount === 1) firstController = c;
        },
      });

      const parser = createMessageParser((msg) => {
        if (!("id" in msg) || !("method" in msg)) return;
        const req = msg as JsonRpcRequest;
        let result: unknown = null;
        if (req.method === "initialize") {
          result = { capabilities: { hoverProvider: true } };
        } else if (req.method === "textDocument/hover") {
          if (transportCount === 1) {
            // Simulate EPIPE on first transport
            const errResp: JsonRpcResponse = {
              jsonrpc: "2.0",
              id: req.id,
              error: { code: -32000, message: "EPIPE: broken pipe" },
            };
            controller?.enqueue(encodeMessage(errResp));
            return;
          }
          result = { contents: { kind: "plaintext", value: "hover after reconnect" } };
        } else if (req.method === "shutdown") {
          result = null;
        }
        controller?.enqueue(encodeMessage({ jsonrpc: "2.0", id: req.id, result }));
      });
      const stdin = {
        write: (d: Uint8Array) => {
          parser(d);
        },
        flush: () => {},
      } as unknown as import("bun").FileSink;

      let resolveExited: (n: number) => void = () => {};
      const exited = new Promise<number>((r) => {
        resolveExited = r;
      });
      const dispose = (): void => {
        resolveExited(0);
        controller?.close();
      };

      return { stdin, stdout, exited, dispose };
    };

    const client = createLspClient(TEST_CONFIG, 2, 5_000, factory);
    await client.connect();
    expect(transportCount).toBe(1);

    // This should reconnect after EPIPE and retry successfully
    const result = await client.hover("file:///test.ts", 0, 0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        (result.value as { readonly contents: { readonly value: string } } | null)?.contents.value,
      ).toBe("hover after reconnect");
    }
    expect(transportCount).toBe(2);

    await client.close();
    void firstController; // used in closure
  });

  test("resyncDocuments sends open docs after successful reconnect", async () => {
    const didOpenUris: string[] = [];
    let transportCount = 0;

    const factory: CreateTransportFn = (): LspTransport => {
      transportCount++;
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      const stdout = new ReadableStream<Uint8Array>({
        start: (c) => {
          controller = c;
        },
      });

      const parser = createMessageParser((msg) => {
        if ("method" in msg && !("id" in msg)) {
          const notif = msg as { readonly method: string; readonly params?: unknown };
          if (notif.method === "textDocument/didOpen") {
            const params = notif.params as { readonly textDocument?: { readonly uri?: string } };
            if (typeof params?.textDocument?.uri === "string") {
              didOpenUris.push(params.textDocument.uri);
            }
          }
          return;
        }
        if (!("id" in msg) || !("method" in msg)) return;
        const req = msg as JsonRpcRequest;
        let result: unknown = null;
        if (req.method === "initialize") {
          result = { capabilities: { hoverProvider: true } };
        } else if (req.method === "textDocument/hover") {
          if (transportCount === 1) {
            const errResp: JsonRpcResponse = {
              jsonrpc: "2.0",
              id: req.id,
              error: { code: -32000, message: "Connection disposed" },
            };
            controller?.enqueue(encodeMessage(errResp));
            return;
          }
          result = { contents: "ok" };
        } else if (req.method === "shutdown") {
          result = null;
        }
        controller?.enqueue(encodeMessage({ jsonrpc: "2.0", id: req.id, result }));
      });

      const stdin = {
        write: (d: Uint8Array) => {
          parser(d);
        },
        flush: () => {},
      } as unknown as import("bun").FileSink;

      return { stdin, stdout, exited: new Promise(() => {}), dispose: () => {} };
    };

    const client = createLspClient(TEST_CONFIG, 2, 5_000, factory);
    await client.connect();

    // Open a document before the reconnect
    await client.openDocument("file:///watched.ts", "const x = 1;", "typescript");

    // Clear tracking (only care about didOpen sent during resync)
    didOpenUris.length = 0;

    // Trigger hover which will fail with connection error → reconnect → resync
    await client.hover("file:///test.ts", 0, 0);

    // After reconnect, the resync should have sent didOpen for watched.ts
    expect(didOpenUris).toContain("file:///watched.ts");

    await client.close();
  });

  test("returns reconnect exhausted error after max attempts", async () => {
    const factory: CreateTransportFn = (): LspTransport => {
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      const stdout = new ReadableStream<Uint8Array>({
        start: (c) => {
          controller = c;
        },
      });

      const parser = createMessageParser((msg) => {
        if (!("id" in msg) || !("method" in msg)) return;
        const req = msg as JsonRpcRequest;
        if (req.method === "initialize") {
          controller?.enqueue(
            encodeMessage({
              jsonrpc: "2.0",
              id: req.id,
              result: { capabilities: { hoverProvider: true } },
            }),
          );
        } else if (req.method === "textDocument/hover") {
          // Always fail with connection error to exhaust reconnects
          controller?.enqueue(
            encodeMessage({
              jsonrpc: "2.0",
              id: req.id,
              error: { code: -32000, message: "EPIPE: pipe broken" },
            }),
          );
          // Close stdout to simulate process dying
          controller?.close();
        }
      });

      const stdin = {
        write: (d: Uint8Array) => {
          parser(d);
        },
        flush: () => {},
      } as unknown as import("bun").FileSink;

      return { stdin, stdout, exited: new Promise(() => {}), dispose: () => {} };
    };

    // maxReconnectAttempts = 0 means no reconnect attempts allowed
    const client = createLspClient(TEST_CONFIG, 0, 5_000, factory);
    await client.connect();

    const result = await client.hover("file:///test.ts", 0, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // With 0 attempts, reconnect immediately exhausted
      expect(
        result.error.message.includes("reconnection failed") ||
          result.error.message.includes("EPIPE"),
      ).toBe(true);
    }
  });

  test("retry operation fails after reconnect succeeds → returns error", async () => {
    // let is justified: count transport creations
    let transportCount = 0;

    const factory: CreateTransportFn = (): LspTransport => {
      transportCount++;
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      const stdout = new ReadableStream<Uint8Array>({
        start: (c) => {
          controller = c;
        },
      });

      const parser = createMessageParser((msg) => {
        if (!("id" in msg) || !("method" in msg)) return;
        const req = msg as JsonRpcRequest;
        if (req.method === "initialize") {
          controller?.enqueue(
            encodeMessage({
              jsonrpc: "2.0",
              id: req.id,
              result: { capabilities: { hoverProvider: true } },
            }),
          );
        } else if (req.method === "textDocument/hover") {
          // Always fail: first transport with connection error, second with method error
          const errMsg = transportCount === 1 ? "EPIPE: broken pipe" : "Internal server error";
          controller?.enqueue(
            encodeMessage({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: errMsg } }),
          );
        } else if (req.method === "shutdown") {
          controller?.enqueue(encodeMessage({ jsonrpc: "2.0", id: req.id, result: null }));
        }
      });

      const stdin = {
        write: (d: Uint8Array) => {
          parser(d);
        },
        flush: () => {},
      } as unknown as import("bun").FileSink;

      return { stdin, stdout, exited: new Promise(() => {}), dispose: () => {} };
    };

    const client = createLspClient(TEST_CONFIG, 2, 5_000, factory);
    await client.connect();
    expect(transportCount).toBe(1);

    // First hover: triggers EPIPE → reconnect (transport 2) → retry hover → method error
    const result = await client.hover("file:///test.ts", 0, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Internal server error");
    }
    expect(transportCount).toBe(2);

    await client.close();
  });

  // -----------------------------------------------------------------------
  // Content-modified retry tests
  // -----------------------------------------------------------------------

  test("content-modified error (-32801) is retried up to 3 times", async () => {
    // let is justified: tracks hover attempt count
    let hoverAttempts = 0;

    const factory: CreateTransportFn = (): LspTransport => {
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      const stdout = new ReadableStream<Uint8Array>({
        start: (c) => {
          controller = c;
        },
      });

      const parser = createMessageParser((msg) => {
        if (!("id" in msg) || !("method" in msg)) return;
        const req = msg as JsonRpcRequest;
        if (req.method === "initialize") {
          controller?.enqueue(
            encodeMessage({
              jsonrpc: "2.0",
              id: req.id,
              result: { capabilities: { hoverProvider: true } },
            }),
          );
        } else if (req.method === "textDocument/hover") {
          hoverAttempts++;
          if (hoverAttempts < 4) {
            // First 3 attempts: content-modified error
            controller?.enqueue(
              encodeMessage({
                jsonrpc: "2.0",
                id: req.id,
                error: { code: -32801, message: "content modified" },
              }),
            );
          } else {
            // 4th attempt (index 3): success
            controller?.enqueue(
              encodeMessage({
                jsonrpc: "2.0",
                id: req.id,
                result: { contents: { kind: "plaintext", value: "ok" } },
              }),
            );
          }
        } else if (req.method === "shutdown") {
          controller?.enqueue(encodeMessage({ jsonrpc: "2.0", id: req.id, result: null }));
        }
      });

      const stdin = {
        write: (d: Uint8Array) => {
          parser(d);
        },
        flush: () => {},
      } as unknown as import("bun").FileSink;

      return { stdin, stdout, exited: new Promise(() => {}), dispose: () => {} };
    };

    const client = createLspClient(TEST_CONFIG, 2, 5_000, factory);
    await client.connect();

    const result = await client.hover("file:///test.ts", 0, 0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const hover = result.value as { readonly contents: { readonly value: string } } | null;
      expect(hover?.contents.value).toBe("ok");
    }
    // 3 failures + 1 success = 4 hover attempts
    expect(hoverAttempts).toBe(4);

    await client.close();
  }, 15_000);

  test("content-modified error exhausted after 3 retries returns error", async () => {
    // let is justified: tracks hover attempt count
    let hoverAttempts = 0;

    const factory: CreateTransportFn = (): LspTransport => {
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      const stdout = new ReadableStream<Uint8Array>({
        start: (c) => {
          controller = c;
        },
      });

      const parser = createMessageParser((msg) => {
        if (!("id" in msg) || !("method" in msg)) return;
        const req = msg as JsonRpcRequest;
        if (req.method === "initialize") {
          controller?.enqueue(
            encodeMessage({
              jsonrpc: "2.0",
              id: req.id,
              result: { capabilities: { hoverProvider: true } },
            }),
          );
        } else if (req.method === "textDocument/hover") {
          hoverAttempts++;
          // Always fail with content-modified
          controller?.enqueue(
            encodeMessage({
              jsonrpc: "2.0",
              id: req.id,
              error: { code: -32801, message: "content modified" },
            }),
          );
        } else if (req.method === "shutdown") {
          controller?.enqueue(encodeMessage({ jsonrpc: "2.0", id: req.id, result: null }));
        }
      });

      const stdin = {
        write: (d: Uint8Array) => {
          parser(d);
        },
        flush: () => {},
      } as unknown as import("bun").FileSink;

      return { stdin, stdout, exited: new Promise(() => {}), dispose: () => {} };
    };

    const client = createLspClient(TEST_CONFIG, 2, 5_000, factory);
    await client.connect();

    const result = await client.hover("file:///test.ts", 0, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("content modified");
    }
    // 1 original + 3 retries = 4 hover attempts total
    expect(hoverAttempts).toBe(4);

    await client.close();
  }, 15_000);

  // -----------------------------------------------------------------------
  // File size check tests
  // -----------------------------------------------------------------------

  test("openDocument blocks files larger than 10MB", async () => {
    const { factory } = createMockTransportFactory();
    const client = createLspClient(TEST_CONFIG, 2, 5_000, factory);
    await client.connect();

    // Use a real temp file that's oversized
    const tmpPath = `/tmp/koi-lsp-test-large-${Date.now()}.ts`;
    // Write just enough metadata to simulate a large file via Bun.file stat mock
    // Since we can't easily create a 10MB+ file, we test with a real small file
    // and verify the guard works by mocking. Instead, test the happy path with a real small file.
    const smallFile = Bun.file(tmpPath);
    await Bun.write(tmpPath, "const x = 1;");

    const smallResult = await client.openDocument(
      `file://${tmpPath}`,
      "const x = 1;",
      "typescript",
    );
    expect(smallResult.ok).toBe(true);

    // Clean up
    await Bun.file(tmpPath)
      .arrayBuffer()
      .catch(() => null);
    import("node:fs").then((fs) => fs.unlinkSync(tmpPath)).catch(() => null);

    await client.close();
    void smallFile;
  });

  test("openDocument returns VALIDATION error for files larger than 10MB", async () => {
    const { factory } = createMockTransportFactory();
    const client = createLspClient(TEST_CONFIG, 2, 5_000, factory);
    await client.connect();

    // Create a real 11MB temp file to trigger the size guard
    const tmpPath = `/tmp/koi-lsp-test-11mb-${Date.now()}.ts`;
    const elevenMB = new Uint8Array(11 * 1024 * 1024);
    await Bun.write(tmpPath, elevenMB);

    const result = await client.openDocument(`file://${tmpPath}`, "", "typescript");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("too large");
      expect(result.error.message).toContain("MB");
    }

    // Clean up
    import("node:fs").then((fs) => fs.unlinkSync(tmpPath)).catch(() => null);

    await client.close();
  });

  test("openDocument skips size check for non-file URIs", async () => {
    const { factory } = createMockTransportFactory();
    const client = createLspClient(TEST_CONFIG, 2, 5_000, factory);
    await client.connect();

    // Non-file URI — size check is skipped entirely
    const result = await client.openDocument(
      "untitled:///new-buffer",
      "const x = 1;",
      "typescript",
    );
    expect(result.ok).toBe(true);

    await client.close();
  });

  test("openDocument succeeds when file does not exist on disk (in-memory buffer)", async () => {
    const { factory } = createMockTransportFactory();
    const client = createLspClient(TEST_CONFIG, 2, 5_000, factory);
    await client.connect();

    // File doesn't exist — stat will throw, size check is skipped
    const result = await client.openDocument(
      "file:///nonexistent-in-memory-buffer.ts",
      "const x = 1;",
      "typescript",
    );
    expect(result.ok).toBe(true);

    await client.close();
  });
});
