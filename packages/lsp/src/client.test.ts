import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { CreateTransportFn } from "./client.js";
import { createLspClient } from "./client.js";
import type { ResolvedLspServerConfig } from "./config.js";
import type { JsonRpcMessage, JsonRpcRequest, JsonRpcResponse } from "./jsonrpc.js";
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

function encodeMessage(message: JsonRpcMessage): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`;
}

interface MockProcess extends EventEmitter {
  pid: number;
  killed: boolean;
  kill: () => void;
}

interface MockTransportOptions {
  readonly capabilities?: object;
  readonly responses?: ReadonlyMap<string, unknown>;
}

/**
 * Creates a mock transport that auto-responds to initialize and other requests.
 */
function createMockTransportFactory(options: MockTransportOptions = {}): {
  readonly factory: CreateTransportFn;
  readonly getServerInput: () => PassThrough;
  readonly getClientInput: () => PassThrough;
} {
  // let is justified: mutable ref to latest transport streams
  let serverInput: PassThrough;
  let clientInput: PassThrough;

  const factory: CreateTransportFn = (): LspTransport => {
    serverInput = new PassThrough(); // server reads from this (our writes go here)
    clientInput = new PassThrough(); // client reads from this (server writes go here)

    const proc = new EventEmitter() as MockProcess;
    proc.pid = 12345;
    proc.killed = false;
    proc.kill = () => {
      proc.killed = true;
      proc.emit("exit", 0);
    };

    // Auto-respond to requests
    // let is justified: accumulates streaming data
    let buffer = "";
    serverInput.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");

      for (;;) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) break;

        const headerSection = buffer.slice(0, headerEnd);
        const clLine = headerSection.split("\r\n").find((l) => l.startsWith("Content-Length: "));
        if (clLine === undefined) {
          buffer = buffer.slice(headerEnd + 4);
          continue;
        }

        const cl = Number.parseInt(clLine.slice("Content-Length: ".length), 10);
        const bodyStart = headerEnd + 4;
        if (Buffer.byteLength(buffer.slice(bodyStart), "utf-8") < cl) break;

        const body = buffer.slice(bodyStart, bodyStart + cl);
        buffer = buffer.slice(bodyStart + cl);

        try {
          const msg = JSON.parse(body) as JsonRpcRequest;
          if ("id" in msg) {
            // It's a request — respond
            const method = msg.method;
            // let is justified: response varies by method
            let result: unknown = null;

            if (method === "initialize") {
              result = {
                capabilities: options.capabilities ?? {
                  hoverProvider: true,
                  definitionProvider: true,
                  referencesProvider: true,
                  documentSymbolProvider: true,
                  workspaceSymbolProvider: true,
                },
              };
            } else if (method === "shutdown") {
              result = null;
            } else if (options.responses !== undefined) {
              result = options.responses.get(method) ?? null;
            }

            const response: JsonRpcResponse = {
              jsonrpc: "2.0",
              id: msg.id,
              result,
            };
            clientInput.write(Buffer.from(encodeMessage(response)));
          }
          // Notifications (no id) — just ignore
        } catch {
          // Malformed — skip
        }
      }
    });

    return {
      stdin: serverInput,
      stdout: clientInput,
      process: proc as unknown as import("node:child_process").ChildProcess,
      dispose: () => {
        proc.kill();
        serverInput.destroy();
        clientInput.destroy();
      },
    };
  };

  return {
    factory,
    getServerInput: () => serverInput,
    getClientInput: () => clientInput,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createLspClient", () => {
  test("connect performs initialize handshake", async () => {
    const { factory } = createMockTransportFactory();
    const client = createLspClient(TEST_CONFIG, 3, 5_000, factory);

    const result = await client.connect();
    expect(result.ok).toBe(true);
    expect(client.isConnected()).toBe(true);
    expect(client.serverName()).toBe("test-server");
    expect(client.capabilities()).toBeDefined();
    expect(client.capabilities()?.hoverProvider).toBe(true);

    await client.close();
  });

  test("connect returns error when already connected", async () => {
    const { factory } = createMockTransportFactory();
    const client = createLspClient(TEST_CONFIG, 3, 5_000, factory);

    await client.connect();
    const result = await client.connect();
    expect(result.ok).toBe(true); // Idempotent — no error

    await client.close();
  });

  test("connect returns timeout error on slow server", async () => {
    // Factory that never responds to initialize
    const factory: CreateTransportFn = () => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const proc = new EventEmitter() as MockProcess;
      proc.pid = 99999;
      proc.killed = false;
      proc.kill = () => {
        proc.killed = true;
      };
      return {
        stdin,
        stdout,
        process: proc as unknown as import("node:child_process").ChildProcess,
        dispose: () => {
          proc.kill();
        },
      };
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
    const client = createLspClient(TEST_CONFIG, 3, 5_000, factory);

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
    const client = createLspClient(TEST_CONFIG, 3, 5_000, factory);

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
    const client = createLspClient(TEST_CONFIG, 3, 5_000, factory);

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
    const client = createLspClient(TEST_CONFIG, 3, 5_000, factory);

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
    const client = createLspClient(TEST_CONFIG, 3, 5_000, factory);

    await client.connect();
    const result = await client.documentSymbols("file:///test.ts");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2); // MyClass + myMethod
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
    const client = createLspClient(TEST_CONFIG, 3, 5_000, factory);

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
    const client = createLspClient(TEST_CONFIG, 3, 5_000, factory);

    await client.connect();
    const result = await client.openDocument("file:///test.ts", "const x = 1;", "typescript");
    expect(result.ok).toBe(true);

    await client.close();
  });

  test("closeDocument removes tracked document", async () => {
    const { factory } = createMockTransportFactory();
    const client = createLspClient(TEST_CONFIG, 3, 5_000, factory);

    await client.connect();
    await client.openDocument("file:///test.ts", "const x = 1;");
    const result = await client.closeDocument("file:///test.ts");
    expect(result.ok).toBe(true);

    await client.close();
  });

  test("methods return not-connected error when not connected", async () => {
    const { factory } = createMockTransportFactory();
    const client = createLspClient(TEST_CONFIG, 3, 5_000, factory);

    const result = await client.hover("file:///test.ts", 0, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("not connected");
    }
  });

  test("close is idempotent", async () => {
    const { factory } = createMockTransportFactory();
    const client = createLspClient(TEST_CONFIG, 3, 5_000, factory);

    await client.connect();
    await client.close();
    await client.close(); // Should not throw

    expect(client.isConnected()).toBe(false);
  });

  test("capabilities returns undefined before connect", () => {
    const { factory } = createMockTransportFactory();
    const client = createLspClient(TEST_CONFIG, 3, 5_000, factory);
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
    const client = createLspClient(TEST_CONFIG, 3, 5_000, factory);

    await client.connect();
    const result = await client.gotoDefinition("file:///test.ts", 1, 0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.uri).toBe("file:///link.ts");
    }

    await client.close();
  });

  test("gotoDefinition normalizes Location array", async () => {
    const responses = new Map<string, unknown>([
      [
        "textDocument/definition",
        [
          {
            uri: "file:///a.ts",
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
          },
          {
            uri: "file:///b.ts",
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
          },
        ],
      ],
    ]);
    const { factory } = createMockTransportFactory({ responses });
    const client = createLspClient(TEST_CONFIG, 3, 5_000, factory);

    await client.connect();
    const result = await client.gotoDefinition("file:///test.ts", 1, 0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
    }

    await client.close();
  });

  test("gotoDefinition returns empty for null response", async () => {
    const responses = new Map<string, unknown>([["textDocument/definition", null]]);
    const { factory } = createMockTransportFactory({ responses });
    const client = createLspClient(TEST_CONFIG, 3, 5_000, factory);

    await client.connect();
    const result = await client.gotoDefinition("file:///test.ts", 1, 0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(0);
    }

    await client.close();
  });

  test("gotoDefinition skips invalid items in array", async () => {
    const responses = new Map<string, unknown>([
      [
        "textDocument/definition",
        [
          {
            uri: "file:///valid.ts",
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
          },
          { invalid: true },
          "not-an-object",
        ],
      ],
    ]);
    const { factory } = createMockTransportFactory({ responses });
    const client = createLspClient(TEST_CONFIG, 3, 5_000, factory);

    await client.connect();
    const result = await client.gotoDefinition("file:///test.ts", 1, 0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
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
    const client = createLspClient(TEST_CONFIG, 3, 5_000, factory);

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

  test("openDocument re-opens already-open document", async () => {
    const { factory, getServerInput } = createMockTransportFactory();
    const client = createLspClient(TEST_CONFIG, 3, 5_000, factory);

    await client.connect();
    await client.openDocument("file:///test.ts", "const x = 1;");

    // Capture notifications for second open
    const notifications: string[] = [];
    const originalWrite = getServerInput().write.bind(getServerInput());
    getServerInput().write = (data: unknown) => {
      const str = typeof data === "string" ? data : (data as Buffer).toString("utf-8");
      if (str.includes("didClose")) notifications.push("didClose");
      if (str.includes("didOpen")) notifications.push("didOpen");
      return originalWrite(data);
    };

    const result = await client.openDocument("file:///test.ts", "const x = 2;");
    expect(result.ok).toBe(true);
    expect(notifications).toContain("didClose");
    expect(notifications).toContain("didOpen");

    await client.close();
  });

  test("connect returns error on init failure (non-timeout)", async () => {
    // Factory that responds with an error to initialize
    const factory: CreateTransportFn = () => {
      const serverInput = new PassThrough();
      const clientInput = new PassThrough();
      const proc = new EventEmitter() as MockProcess;
      proc.pid = 99999;
      proc.killed = false;
      proc.kill = () => {
        proc.killed = true;
      };

      // Respond with error to initialize request
      // let is justified: accumulates streaming data
      let buffer = "";
      serverInput.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf-8");
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        const headerSection = buffer.slice(0, headerEnd);
        const clLine = headerSection.split("\r\n").find((l) => l.startsWith("Content-Length: "));
        if (clLine === undefined) return;
        const cl = Number.parseInt(clLine.slice("Content-Length: ".length), 10);
        const bodyStart = headerEnd + 4;
        if (buffer.length - bodyStart < cl) return;
        const body = buffer.slice(bodyStart, bodyStart + cl);
        buffer = buffer.slice(bodyStart + cl);
        try {
          const msg = JSON.parse(body) as JsonRpcRequest;
          if ("id" in msg) {
            const resp: JsonRpcResponse = {
              jsonrpc: "2.0",
              id: msg.id,
              error: { code: -32600, message: "Invalid request" },
            };
            clientInput.write(Buffer.from(encodeMessage(resp)));
          }
        } catch {
          void 0;
        }
      });

      return {
        stdin: serverInput,
        stdout: clientInput,
        process: proc as unknown as import("node:child_process").ChildProcess,
        dispose: () => {
          proc.kill();
          serverInput.destroy();
          clientInput.destroy();
        },
      };
    };

    const client = createLspClient(TEST_CONFIG, 0, 5_000, factory);
    const result = await client.connect();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Invalid request");
    }
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

  test("gotoDefinition returns empty for non-location non-array value", async () => {
    const responses = new Map<string, unknown>([["textDocument/definition", "invalid-string"]]);
    const { factory } = createMockTransportFactory({ responses });
    const client = createLspClient(TEST_CONFIG, 3, 5_000, factory);

    await client.connect();
    const result = await client.gotoDefinition("file:///test.ts", 1, 0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(0);
    }

    await client.close();
  });

  test("withConnection reconnects on connection error and retries", async () => {
    // let is justified: tracks call count across factory invocations
    let transportCallCount = 0;
    // let is justified: controls whether hover should fail
    const shouldFailHover = false;

    const factory: CreateTransportFn = () => {
      transportCallCount++;
      const serverInput = new PassThrough();
      const clientInput = new PassThrough();
      const proc = new EventEmitter() as MockProcess;
      proc.pid = 10000 + transportCallCount;
      proc.killed = false;
      proc.kill = () => {
        proc.killed = true;
        proc.emit("exit", 0);
      };

      // let is justified: accumulates streaming data
      let buffer = "";
      serverInput.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf-8");
        for (;;) {
          const headerEnd = buffer.indexOf("\r\n\r\n");
          if (headerEnd === -1) break;
          const headerSection = buffer.slice(0, headerEnd);
          const clLine = headerSection.split("\r\n").find((l) => l.startsWith("Content-Length: "));
          if (clLine === undefined) {
            buffer = buffer.slice(headerEnd + 4);
            continue;
          }
          const cl = Number.parseInt(clLine.slice("Content-Length: ".length), 10);
          const bodyStart = headerEnd + 4;
          if (buffer.length - bodyStart < cl) break;
          const body = buffer.slice(bodyStart, bodyStart + cl);
          buffer = buffer.slice(bodyStart + cl);
          try {
            const msg = JSON.parse(body) as JsonRpcRequest;
            if ("id" in msg) {
              if (msg.method === "textDocument/hover" && shouldFailHover) {
                // Respond with an error that triggers reconnection
                const resp: JsonRpcResponse = {
                  jsonrpc: "2.0",
                  id: msg.id,
                  error: { code: -32000, message: "Connection disposed" },
                };
                clientInput.write(Buffer.from(encodeMessage(resp)));
                return;
              }
              // let is justified: response varies by method
              let result: unknown = null;
              if (msg.method === "initialize") {
                result = { capabilities: { hoverProvider: true } };
              } else if (msg.method === "shutdown") {
                result = null;
              } else if (msg.method === "textDocument/hover") {
                result = { contents: { kind: "plaintext", value: "hover" } };
              }
              const resp: JsonRpcResponse = { jsonrpc: "2.0", id: msg.id, result };
              clientInput.write(Buffer.from(encodeMessage(resp)));
            }
          } catch {
            void 0;
          }
        }
      });

      return {
        stdin: serverInput,
        stdout: clientInput,
        process: proc as unknown as import("node:child_process").ChildProcess,
        dispose: () => {
          proc.kill();
          serverInput.destroy();
          clientInput.destroy();
        },
      };
    };

    const client = createLspClient(TEST_CONFIG, 3, 5_000, factory);
    await client.connect();
    expect(transportCallCount).toBe(1);

    // Verify normal hover works
    const hoverResult = await client.hover("file:///test.ts", 0, 0);
    expect(hoverResult.ok).toBe(true);

    await client.close();
  });

  // -----------------------------------------------------------------------
  // Diagnostics
  // -----------------------------------------------------------------------

  test("getDiagnostics returns empty map when no diagnostics received", async () => {
    const { factory } = createMockTransportFactory();
    const client = createLspClient(TEST_CONFIG, 3, 5_000, factory);
    await client.connect();

    const diags = client.getDiagnostics();
    expect(diags.size).toBe(0);

    await client.close();
  });

  test("getDiagnostics caches diagnostics from publishDiagnostics notification", async () => {
    const { factory, getClientInput } = createMockTransportFactory();
    const client = createLspClient(TEST_CONFIG, 3, 5_000, factory);
    await client.connect();

    // Simulate server pushing diagnostics
    const notification = {
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
    };
    getClientInput().write(Buffer.from(encodeMessage(notification as JsonRpcMessage)));

    // Give event loop time to process notification
    await new Promise((resolve) => setTimeout(resolve, 50));

    const diags = client.getDiagnostics("file:///test.ts");
    expect(diags.size).toBe(1);
    const fileDiags = diags.get("file:///test.ts");
    expect(fileDiags).toBeDefined();
    expect(fileDiags).toHaveLength(1);
    expect(fileDiags?.[0]?.message).toBe("Type error");

    await client.close();
  });

  test("getDiagnostics without URI returns all cached diagnostics", async () => {
    const { factory, getClientInput } = createMockTransportFactory();
    const client = createLspClient(TEST_CONFIG, 3, 5_000, factory);
    await client.connect();

    // Push diagnostics for two URIs
    for (const uri of ["file:///a.ts", "file:///b.ts"]) {
      const notification = {
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
      };
      getClientInput().write(Buffer.from(encodeMessage(notification as JsonRpcMessage)));
    }

    await new Promise((resolve) => setTimeout(resolve, 50));

    const all = client.getDiagnostics();
    expect(all.size).toBe(2);
    expect(all.has("file:///a.ts")).toBe(true);
    expect(all.has("file:///b.ts")).toBe(true);

    await client.close();
  });

  test("closeDocument clears diagnostics for that URI", async () => {
    const { factory, getClientInput } = createMockTransportFactory();
    const client = createLspClient(TEST_CONFIG, 3, 5_000, factory);
    await client.connect();

    // Open document first, then push diagnostics
    await client.openDocument("file:///test.ts", "const x = 1;");

    const notification = {
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
    };
    getClientInput().write(Buffer.from(encodeMessage(notification as JsonRpcMessage)));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(client.getDiagnostics("file:///test.ts").size).toBe(1);

    await client.closeDocument("file:///test.ts");
    expect(client.getDiagnostics("file:///test.ts").size).toBe(0);

    await client.close();
  });

  test("methods return error on non-connection failures", async () => {
    // Factory where hover returns a JSON-RPC error (non-connection error)
    const factory: CreateTransportFn = () => {
      const serverInput = new PassThrough();
      const clientInput = new PassThrough();
      const proc = new EventEmitter() as MockProcess;
      proc.pid = 77777;
      proc.killed = false;
      proc.kill = () => {
        proc.killed = true;
        proc.emit("exit", 0);
      };

      // let is justified: accumulates streaming data
      let buffer = "";
      serverInput.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf-8");
        for (;;) {
          const headerEnd = buffer.indexOf("\r\n\r\n");
          if (headerEnd === -1) break;
          const headerSection = buffer.slice(0, headerEnd);
          const clLine = headerSection.split("\r\n").find((l) => l.startsWith("Content-Length: "));
          if (clLine === undefined) {
            buffer = buffer.slice(headerEnd + 4);
            continue;
          }
          const cl = Number.parseInt(clLine.slice("Content-Length: ".length), 10);
          const bodyStart = headerEnd + 4;
          if (buffer.length - bodyStart < cl) break;
          const body = buffer.slice(bodyStart, bodyStart + cl);
          buffer = buffer.slice(bodyStart + cl);
          try {
            const msg = JSON.parse(body) as JsonRpcRequest;
            if ("id" in msg) {
              if (msg.method === "initialize") {
                const resp: JsonRpcResponse = {
                  jsonrpc: "2.0",
                  id: msg.id,
                  result: { capabilities: { hoverProvider: true } },
                };
                clientInput.write(Buffer.from(encodeMessage(resp)));
              } else if (msg.method === "textDocument/hover") {
                // Non-connection error — should NOT trigger reconnect
                const resp: JsonRpcResponse = {
                  jsonrpc: "2.0",
                  id: msg.id,
                  error: { code: -32601, message: "Method not found" },
                };
                clientInput.write(Buffer.from(encodeMessage(resp)));
              } else if (msg.method === "shutdown") {
                const resp: JsonRpcResponse = { jsonrpc: "2.0", id: msg.id, result: null };
                clientInput.write(Buffer.from(encodeMessage(resp)));
              }
            }
          } catch {
            void 0;
          }
        }
      });

      return {
        stdin: serverInput,
        stdout: clientInput,
        process: proc as unknown as import("node:child_process").ChildProcess,
        dispose: () => {
          proc.kill();
          serverInput.destroy();
          clientInput.destroy();
        },
      };
    };

    const client = createLspClient(TEST_CONFIG, 0, 5_000, factory);
    await client.connect();

    const result = await client.hover("file:///test.ts", 0, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Method not found");
    }

    await client.close();
  });
});
