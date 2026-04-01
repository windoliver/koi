import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { JsonRpcMessage, JsonRpcResponse } from "./jsonrpc.js";
import { createJsonRpcConnection, createMessageParser, writeMessage } from "./jsonrpc.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createStreams(): {
  readonly clientIn: PassThrough;
  readonly clientOut: PassThrough;
} {
  return {
    clientIn: new PassThrough(),
    clientOut: new PassThrough(),
  };
}

function encodeMessage(message: JsonRpcMessage): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`;
}

// ---------------------------------------------------------------------------
// writeMessage
// ---------------------------------------------------------------------------

describe("writeMessage", () => {
  test("writes Content-Length header and JSON body", () => {
    const output = new PassThrough();
    const chunks: Uint8Array[] = [];
    output.on("data", (chunk: Uint8Array) => chunks.push(chunk));

    writeMessage(output, { jsonrpc: "2.0", id: 1, method: "test" });

    const written = Buffer.concat(chunks).toString("utf-8");
    expect(written).toContain("Content-Length:");
    expect(written).toContain('"jsonrpc":"2.0"');
    expect(written).toContain('"method":"test"');
  });
});

// ---------------------------------------------------------------------------
// createMessageParser
// ---------------------------------------------------------------------------

describe("createMessageParser", () => {
  test("parses a single complete message", () => {
    const messages: JsonRpcMessage[] = [];
    const parse = createMessageParser((msg) => messages.push(msg));

    const encoded = encodeMessage({ jsonrpc: "2.0", id: 1, method: "initialize" });
    parse(Buffer.from(encoded));

    expect(messages).toHaveLength(1);
    expect((messages[0] as { readonly method: string }).method).toBe("initialize");
  });

  test("handles message split across chunks", () => {
    const messages: JsonRpcMessage[] = [];
    const parse = createMessageParser((msg) => messages.push(msg));

    const encoded = encodeMessage({ jsonrpc: "2.0", id: 1, method: "test" });
    const mid = Math.floor(encoded.length / 2);

    parse(Buffer.from(encoded.slice(0, mid)));
    expect(messages).toHaveLength(0);

    parse(Buffer.from(encoded.slice(mid)));
    expect(messages).toHaveLength(1);
  });

  test("handles multiple messages in one chunk", () => {
    const messages: JsonRpcMessage[] = [];
    const parse = createMessageParser((msg) => messages.push(msg));

    const msg1 = encodeMessage({ jsonrpc: "2.0", id: 1, method: "first" });
    const msg2 = encodeMessage({ jsonrpc: "2.0", id: 2, method: "second" });

    parse(Buffer.from(msg1 + msg2));

    expect(messages).toHaveLength(2);
  });

  test("skips malformed JSON", () => {
    const messages: JsonRpcMessage[] = [];
    const parse = createMessageParser((msg) => messages.push(msg));

    const header = "Content-Length: 3\r\n\r\n";
    parse(Buffer.from(`${header}bad`));

    expect(messages).toHaveLength(0);
  });

  test("skips headers without Content-Length", () => {
    const messages: JsonRpcMessage[] = [];
    const parse = createMessageParser((msg) => messages.push(msg));

    const noLength = "X-Custom: header\r\n\r\n";
    const valid = encodeMessage({ jsonrpc: "2.0", method: "test" });
    parse(Buffer.from(noLength + valid));

    expect(messages).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// createJsonRpcConnection
// ---------------------------------------------------------------------------

describe("createJsonRpcConnection", () => {
  test("sends request and receives response", async () => {
    const { clientIn, clientOut } = createStreams();
    const conn = createJsonRpcConnection(clientIn, clientOut);

    // Capture outgoing request
    const outChunks: Buffer[] = [];
    clientOut.on("data", (chunk: Buffer) => outChunks.push(chunk));

    // Send request
    const responsePromise = conn.sendRequest<{ readonly contents: string }>("textDocument/hover", {
      uri: "file:///test.ts",
    });

    // Simulate response from server
    const response: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: { contents: "hover info" },
    };
    clientIn.write(Buffer.from(encodeMessage(response)));

    const result = await responsePromise;
    expect(result).toEqual({ contents: "hover info" });

    conn.dispose();
  });

  test("handles concurrent requests with id-based routing", async () => {
    const { clientIn, clientOut } = createStreams();
    const conn = createJsonRpcConnection(clientIn, clientOut);

    const promise1 = conn.sendRequest<string>("method/a");
    const promise2 = conn.sendRequest<string>("method/b");

    // Respond out of order (id 2 first, then id 1)
    const resp2: JsonRpcResponse = { jsonrpc: "2.0", id: 2, result: "result-b" };
    const resp1: JsonRpcResponse = { jsonrpc: "2.0", id: 1, result: "result-a" };

    clientIn.write(Buffer.from(encodeMessage(resp2)));
    clientIn.write(Buffer.from(encodeMessage(resp1)));

    const [r1, r2] = await Promise.all([promise1, promise2]);
    expect(r1).toBe("result-a");
    expect(r2).toBe("result-b");

    conn.dispose();
  });

  test("rejects on JSON-RPC error response", async () => {
    const { clientIn, clientOut } = createStreams();
    const conn = createJsonRpcConnection(clientIn, clientOut);

    const promise = conn.sendRequest("test/fail");

    const errorResp: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32601, message: "Method not found" },
    };
    clientIn.write(Buffer.from(encodeMessage(errorResp)));

    await expect(promise).rejects.toThrow("Method not found");

    conn.dispose();
  });

  test("rejects on request timeout", async () => {
    const { clientIn, clientOut } = createStreams();
    const conn = createJsonRpcConnection(clientIn, clientOut);

    const promise = conn.sendRequest("test/slow", undefined, 50);

    await expect(promise).rejects.toThrow("timeout");

    conn.dispose();
  });

  test("handles notifications", () => {
    const { clientIn, clientOut } = createStreams();
    const conn = createJsonRpcConnection(clientIn, clientOut);

    const received: unknown[] = [];
    conn.onNotification("window/logMessage", (params) => received.push(params));

    const notification = encodeMessage({
      jsonrpc: "2.0",
      method: "window/logMessage",
      params: { type: 3, message: "hello" },
    });
    clientIn.write(Buffer.from(notification));

    // Give the event loop a tick to process
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(received).toHaveLength(1);
        expect(received[0]).toEqual({ type: 3, message: "hello" });
        conn.dispose();
        resolve();
      }, 10);
    });
  });

  test("unsubscribe removes notification handler", () => {
    const { clientIn, clientOut } = createStreams();
    const conn = createJsonRpcConnection(clientIn, clientOut);

    const received: unknown[] = [];
    const unsubscribe = conn.onNotification("test/event", (params) => received.push(params));
    unsubscribe();

    clientIn.write(
      Buffer.from(encodeMessage({ jsonrpc: "2.0", method: "test/event", params: { x: 1 } })),
    );

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(received).toHaveLength(0);
        conn.dispose();
        resolve();
      }, 10);
    });
  });

  test("sendNotification writes notification without id", () => {
    const { clientIn, clientOut } = createStreams();
    const conn = createJsonRpcConnection(clientIn, clientOut);

    const chunks: Uint8Array[] = [];
    clientOut.on("data", (chunk: Uint8Array) => chunks.push(chunk));

    conn.sendNotification("initialized", {});

    const written = Buffer.concat(chunks).toString("utf-8");
    expect(written).toContain('"method":"initialized"');
    expect(written).not.toContain('"id"');

    conn.dispose();
  });

  test("rejects pending requests on dispose", async () => {
    const { clientIn, clientOut } = createStreams();
    const conn = createJsonRpcConnection(clientIn, clientOut);

    const promise = conn.sendRequest("test/pending");
    conn.dispose();

    await expect(promise).rejects.toThrow("disposed");
  });

  test("rejects new requests after dispose", async () => {
    const { clientIn, clientOut } = createStreams();
    const conn = createJsonRpcConnection(clientIn, clientOut);
    conn.dispose();

    await expect(conn.sendRequest("test/after")).rejects.toThrow("disposed");
  });
});
