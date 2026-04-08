import { describe, expect, test } from "bun:test";
import type { JsonRpcMessage, JsonRpcResponse } from "./jsonrpc.js";
import { createJsonRpcConnection, createMessageParser, writeMessage } from "./jsonrpc.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function encodeMessage(message: JsonRpcMessage): Uint8Array {
  const body = JSON.stringify(message);
  const header = `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n`;
  return Buffer.from(header + body);
}

/**
 * Creates a mock RPC server backed by TransformStreams.
 * - `stdout` is the ReadableStream the client reads from
 * - `mockStdin` captures bytes the client writes
 * - `sendToClient(msg)` injects a message into stdout
 */
function createMockRpcServer(responses: ReadonlyMap<string, unknown>): {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly mockStdin: {
    readonly writtenMessages: JsonRpcMessage[];
    readonly sink: {
      readonly write: (data: Uint8Array) => void;
      readonly flush: () => void;
    };
  };
  readonly sendToClient: (msg: JsonRpcMessage) => void;
} {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;

  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });

  const writtenMessages: JsonRpcMessage[] = [];
  // Use real createMessageParser so we test the full round-trip, not a reimplemented one
  const parser = createMessageParser((msg) => {
    writtenMessages.push(msg);
    // Auto-respond to requests
    if ("id" in msg && "method" in msg) {
      const req = msg as { readonly id: number; readonly method: string };
      let result: unknown = null;
      if (req.method === "initialize") {
        result =
          responses.get("initialize") ??
          ({
            capabilities: {
              hoverProvider: true,
              definitionProvider: true,
              referencesProvider: true,
              documentSymbolProvider: true,
              workspaceSymbolProvider: true,
            },
          } as unknown);
      } else if (req.method === "shutdown") {
        result = null;
      } else {
        result = responses.get(req.method) ?? null;
      }
      const response: JsonRpcResponse = { jsonrpc: "2.0", id: req.id, result };
      controller?.enqueue(encodeMessage(response));
    }
  });

  const mockStdin = {
    writtenMessages,
    sink: {
      write: (data: Uint8Array) => {
        parser(data);
      },
      flush: () => {
        // no-op for tests
      },
    },
  };

  const sendToClient = (msg: JsonRpcMessage): void => {
    controller?.enqueue(encodeMessage(msg));
  };

  return { stdout, mockStdin, sendToClient };
}

// ---------------------------------------------------------------------------
// writeMessage
// ---------------------------------------------------------------------------

describe("writeMessage", () => {
  test("writes Content-Length header and JSON body", () => {
    const written: Uint8Array[] = [];
    const sink = {
      write: (data: Uint8Array) => written.push(data),
      flush: () => {},
    };

    writeMessage(sink as unknown as import("bun").FileSink, {
      jsonrpc: "2.0",
      id: 1,
      method: "test",
    });

    const result = Buffer.concat(written).toString("utf-8");
    expect(result).toContain("Content-Length:");
    expect(result).toContain('"jsonrpc":"2.0"');
    expect(result).toContain('"method":"test"');
  });

  test("flushes after write", () => {
    let flushed = false;
    const sink = {
      write: (_data: Uint8Array) => {},
      flush: () => {
        flushed = true;
      },
    };

    writeMessage(sink as unknown as import("bun").FileSink, {
      jsonrpc: "2.0",
      method: "notify",
    });

    expect(flushed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createMessageParser
// ---------------------------------------------------------------------------

describe("createMessageParser", () => {
  test("parses a single complete message", () => {
    const messages: JsonRpcMessage[] = [];
    const parse = createMessageParser((msg) => messages.push(msg));

    parse(encodeMessage({ jsonrpc: "2.0", id: 1, method: "initialize" }));

    expect(messages).toHaveLength(1);
    expect((messages[0] as { readonly method: string }).method).toBe("initialize");
  });

  test("handles message split across chunks", () => {
    const messages: JsonRpcMessage[] = [];
    const parse = createMessageParser((msg) => messages.push(msg));

    const encoded = Buffer.from(encodeMessage({ jsonrpc: "2.0", id: 1, method: "test" })).toString(
      "utf-8",
    );
    const mid = Math.floor(encoded.length / 2);

    parse(Buffer.from(encoded.slice(0, mid)));
    expect(messages).toHaveLength(0);

    parse(Buffer.from(encoded.slice(mid)));
    expect(messages).toHaveLength(1);
  });

  test("handles multiple messages in one chunk", () => {
    const messages: JsonRpcMessage[] = [];
    const parse = createMessageParser((msg) => messages.push(msg));

    const msg1 = Buffer.from(encodeMessage({ jsonrpc: "2.0", id: 1, method: "first" }));
    const msg2 = Buffer.from(encodeMessage({ jsonrpc: "2.0", id: 2, method: "second" }));
    const combined = Buffer.concat([msg1, msg2]);

    parse(combined);

    expect(messages).toHaveLength(2);
  });

  test("skips malformed JSON", () => {
    const messages: JsonRpcMessage[] = [];
    const parse = createMessageParser((msg) => messages.push(msg));

    parse(Buffer.from("Content-Length: 3\r\n\r\nbad"));

    expect(messages).toHaveLength(0);
  });

  test("skips headers without Content-Length", () => {
    const messages: JsonRpcMessage[] = [];
    const parse = createMessageParser((msg) => messages.push(msg));

    const noLength = Buffer.from("X-Custom: header\r\n\r\n");
    const valid = encodeMessage({ jsonrpc: "2.0", method: "test" });
    parse(Buffer.concat([noLength, valid]));

    expect(messages).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// createJsonRpcConnection
// ---------------------------------------------------------------------------

describe("createJsonRpcConnection", () => {
  test("sends request and receives response", async () => {
    const { stdout, mockStdin } = createMockRpcServer(
      new Map([["textDocument/hover", { contents: "hover info" }]]),
    );

    const conn = createJsonRpcConnection(
      stdout,
      mockStdin.sink as unknown as import("bun").FileSink,
    );

    const result = await conn.sendRequest<{ readonly contents: string }>("textDocument/hover", {
      uri: "file:///test.ts",
    });

    expect(result).toEqual({ contents: "hover info" });
    conn.dispose();
  });

  test("handles concurrent requests with id-based routing", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stdout = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c;
      },
    });

    const pendingIds: number[] = [];
    const parser = createMessageParser((msg) => {
      if ("id" in msg && "method" in msg) {
        const req = msg as { readonly id: number; readonly method: string };
        pendingIds.push(req.id);
      }
    });

    const sink = {
      write: (data: Uint8Array) => {
        parser(data);
      },
      flush: () => {},
    };

    const conn = createJsonRpcConnection(stdout, sink as unknown as import("bun").FileSink);

    const promise1 = conn.sendRequest<string>("method/a");
    const promise2 = conn.sendRequest<string>("method/b");

    // Wait a tick for the sends to be processed
    await new Promise<void>((r) => setTimeout(r, 5));

    // Respond out of order (id 2 first, then id 1)
    const resp2: JsonRpcResponse = { jsonrpc: "2.0", id: 2, result: "result-b" };
    const resp1: JsonRpcResponse = { jsonrpc: "2.0", id: 1, result: "result-a" };
    controller?.enqueue(encodeMessage(resp2));
    controller?.enqueue(encodeMessage(resp1));

    const [r1, r2] = await Promise.all([promise1, promise2]);
    expect(r1).toBe("result-a");
    expect(r2).toBe("result-b");

    conn.dispose();
  });

  test("rejects on JSON-RPC error response", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stdout = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c;
      },
    });
    const sink = { write: (_d: Uint8Array) => {}, flush: () => {} };

    const conn = createJsonRpcConnection(stdout, sink as unknown as import("bun").FileSink);

    const promise = conn.sendRequest("test/fail");

    await new Promise<void>((r) => setTimeout(r, 5));
    const errorResp: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32601, message: "Method not found" },
    };
    controller?.enqueue(encodeMessage(errorResp));

    await expect(promise).rejects.toThrow("Method not found");
    conn.dispose();
  });

  test("rejects on request timeout", async () => {
    const stdout = new ReadableStream<Uint8Array>({ start: () => {} });
    const sink = { write: (_d: Uint8Array) => {}, flush: () => {} };

    const conn = createJsonRpcConnection(stdout, sink as unknown as import("bun").FileSink);

    const promise = conn.sendRequest("test/slow", undefined, 50);
    await expect(promise).rejects.toThrow("timeout");
    conn.dispose();
  });

  test("handles notifications", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stdout = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c;
      },
    });
    const sink = { write: (_d: Uint8Array) => {}, flush: () => {} };

    const conn = createJsonRpcConnection(stdout, sink as unknown as import("bun").FileSink);

    const received: unknown[] = [];
    conn.onNotification("window/logMessage", (params) => received.push(params));

    controller?.enqueue(
      encodeMessage({
        jsonrpc: "2.0",
        method: "window/logMessage",
        params: { type: 3, message: "hello" },
      }),
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ type: 3, message: "hello" });
    conn.dispose();
  });

  test("unsubscribe removes notification handler", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stdout = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c;
      },
    });
    const sink = { write: (_d: Uint8Array) => {}, flush: () => {} };

    const conn = createJsonRpcConnection(stdout, sink as unknown as import("bun").FileSink);

    const received: unknown[] = [];
    const unsubscribe = conn.onNotification("test/event", (params) => received.push(params));
    unsubscribe();

    controller?.enqueue(encodeMessage({ jsonrpc: "2.0", method: "test/event", params: { x: 1 } }));

    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(received).toHaveLength(0);
    conn.dispose();
  });

  test("sendNotification writes notification without id", () => {
    const written: Uint8Array[] = [];
    const sink = { write: (d: Uint8Array) => written.push(d), flush: () => {} };
    const stdout = new ReadableStream<Uint8Array>({ start: () => {} });

    const conn = createJsonRpcConnection(stdout, sink as unknown as import("bun").FileSink);

    conn.sendNotification("initialized", {});

    const result = Buffer.concat(written).toString("utf-8");
    expect(result).toContain('"method":"initialized"');
    expect(result).not.toContain('"id"');
    conn.dispose();
  });

  test("rejects pending requests on dispose", async () => {
    const stdout = new ReadableStream<Uint8Array>({ start: () => {} });
    const sink = { write: (_d: Uint8Array) => {}, flush: () => {} };

    const conn = createJsonRpcConnection(stdout, sink as unknown as import("bun").FileSink);

    const promise = conn.sendRequest("test/pending");
    conn.dispose();

    await expect(promise).rejects.toThrow("disposed");
  });

  test("rejects new requests after dispose", async () => {
    const stdout = new ReadableStream<Uint8Array>({ start: () => {} });
    const sink = { write: (_d: Uint8Array) => {}, flush: () => {} };

    const conn = createJsonRpcConnection(stdout, sink as unknown as import("bun").FileSink);
    conn.dispose();

    await expect(conn.sendRequest("test/after")).rejects.toThrow("disposed");
  });

  test("onRequest handler is called and response is sent back", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stdout = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c;
      },
    });

    const written: Uint8Array[] = [];
    const sink = {
      write: (d: Uint8Array) => written.push(d),
      flush: () => {},
    };

    const conn = createJsonRpcConnection(stdout, sink as unknown as import("bun").FileSink);

    // Register handler for workspace/configuration server request
    const unsubscribe = conn.onRequest("workspace/configuration", (params) => {
      const items = (params as { items?: unknown[] } | undefined)?.items ?? [];
      return items.map(() => null);
    });

    // Simulate server sending a request to the client
    controller?.enqueue(
      encodeMessage({
        jsonrpc: "2.0",
        id: 42,
        method: "workspace/configuration",
        params: { items: [{ section: "typescript" }, { section: "editor" }] },
      }),
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    // The connection should have written a response
    const responseText = Buffer.concat(written).toString("utf-8");
    expect(responseText).toContain('"id":42');
    expect(responseText).toContain('"result":[null,null]');

    unsubscribe();
    conn.dispose();
  });

  test("onRequest with no handler registered returns null result", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stdout = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c;
      },
    });

    const written: Uint8Array[] = [];
    const sink = {
      write: (d: Uint8Array) => written.push(d),
      flush: () => {},
    };

    const conn = createJsonRpcConnection(stdout, sink as unknown as import("bun").FileSink);

    // No handler registered — should respond with null
    controller?.enqueue(
      encodeMessage({
        jsonrpc: "2.0",
        id: 99,
        method: "workspace/configuration",
        params: { items: [] },
      }),
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    const responseText = Buffer.concat(written).toString("utf-8");
    expect(responseText).toContain('"id":99');
    expect(responseText).toContain('"result":null');

    conn.dispose();
  });

  test("onRequest unsubscribe stops sending responses", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stdout = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c;
      },
    });

    const written: Uint8Array[] = [];
    const sink = {
      write: (d: Uint8Array) => written.push(d),
      flush: () => {},
    };

    const conn = createJsonRpcConnection(stdout, sink as unknown as import("bun").FileSink);

    const calls: unknown[] = [];
    const unsubscribe = conn.onRequest("workspace/configuration", (params) => {
      calls.push(params);
      return ["custom"];
    });

    // First request — handler is registered
    controller?.enqueue(
      encodeMessage({ jsonrpc: "2.0", id: 1, method: "workspace/configuration", params: {} }),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(calls).toHaveLength(1);

    // Unsubscribe and send another request — handler no longer called, null response sent
    unsubscribe();
    written.length = 0; // clear recorded writes
    controller?.enqueue(
      encodeMessage({ jsonrpc: "2.0", id: 2, method: "workspace/configuration", params: {} }),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(calls).toHaveLength(1); // handler not called again

    const responseText = Buffer.concat(written).toString("utf-8");
    expect(responseText).toContain('"id":2');
    expect(responseText).toContain('"result":null'); // falls back to null

    conn.dispose();
  });
});
