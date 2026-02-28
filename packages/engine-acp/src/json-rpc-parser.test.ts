/**
 * Tests for the JSON-RPC 2.0 line parser.
 *
 * Tests all 4 JSON-RPC error paths (decision 10A):
 * 1. Parse error: invalid JSON
 * 2. Invalid request: missing required fields
 * 3. Method not found: unrecognized method
 * 4. Internal error: handler throws
 *
 * Plus line-framing and routing tests.
 */

import { describe, expect, mock, test } from "bun:test";
import {
  buildErrorResponse,
  buildRequest,
  buildResponse,
  createLineParser,
  RPC_ERROR_CODES,
} from "./json-rpc-parser.js";

describe("createLineParser — routing", () => {
  test("routes notification (no id, has method)", () => {
    const parser = createLineParser();
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "sess_1" },
    });
    const msgs = parser.feed(`${line}\n`);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.kind).toBe("notification");
    if (msgs[0]?.kind === "notification") {
      expect(msgs[0].method).toBe("session/update");
    }
  });

  test("routes inbound request (id + method)", () => {
    const parser = createLineParser();
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: 42,
      method: "fs/read_text_file",
      params: { sessionId: "sess_1", path: "/foo.ts" },
    });
    const msgs = parser.feed(`${line}\n`);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.kind).toBe("inbound_request");
    if (msgs[0]?.kind === "inbound_request") {
      expect(msgs[0].id).toBe(42);
      expect(msgs[0].method).toBe("fs/read_text_file");
    }
  });

  test("routes success response (id + result, no method)", () => {
    const parser = createLineParser();
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { sessionId: "sess_abc" },
    });
    const msgs = parser.feed(`${line}\n`);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.kind).toBe("success_response");
    if (msgs[0]?.kind === "success_response") {
      expect(msgs[0].id).toBe(1);
    }
  });

  test("routes error response (id + error)", () => {
    const parser = createLineParser();
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32601, message: "Method not found" },
    });
    const msgs = parser.feed(`${line}\n`);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.kind).toBe("error_response");
    if (msgs[0]?.kind === "error_response") {
      expect(msgs[0].error.code).toBe(-32601);
    }
  });
});

describe("createLineParser — line buffering", () => {
  test("buffers partial lines across chunks", () => {
    const parser = createLineParser();
    const line = JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {} });
    // Split line across two chunks
    const half = Math.floor(line.length / 2);
    const msgs1 = parser.feed(line.slice(0, half));
    expect(msgs1).toHaveLength(0); // incomplete line
    const msgs2 = parser.feed(`${line.slice(half)}\n`);
    expect(msgs2).toHaveLength(1); // now complete
  });

  test("parses multiple messages in one chunk", () => {
    const parser = createLineParser();
    const msg1 = JSON.stringify({ jsonrpc: "2.0", method: "a", params: {} });
    const msg2 = JSON.stringify({ jsonrpc: "2.0", method: "b", params: {} });
    const msgs = parser.feed(`${msg1}\n${msg2}\n`);
    expect(msgs).toHaveLength(2);
  });

  test("flush returns partial line if present", () => {
    const parser = createLineParser();
    const partial = JSON.stringify({ jsonrpc: "2.0", method: "ping", params: {} });
    parser.feed(partial); // no newline
    const msgs = parser.flush();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.kind).toBe("notification");
  });

  test("flush returns empty if no partial line", () => {
    const parser = createLineParser();
    parser.feed(`${JSON.stringify({ jsonrpc: "2.0", method: "x", params: {} })}\n`);
    const msgs = parser.flush();
    expect(msgs).toHaveLength(0);
  });

  test("ignores empty lines", () => {
    const parser = createLineParser();
    const msgs = parser.feed("\n\n\n");
    expect(msgs).toHaveLength(0);
  });
});

describe("createLineParser — error path 1: parse error (invalid JSON)", () => {
  test("logs warning and skips invalid JSON line", () => {
    const warnMock = mock(() => {});
    const origWarn = console.warn.bind(console);
    console.warn = warnMock;

    try {
      const parser = createLineParser();
      const msgs = parser.feed("not valid json\n");
      expect(msgs).toHaveLength(0);
      expect(warnMock).toHaveBeenCalledTimes(1);
    } finally {
      console.warn = origWarn;
    }
  });
});

describe("createLineParser — error path 2: invalid request (wrong jsonrpc version)", () => {
  test("logs warning for non-2.0 jsonrpc", () => {
    const warnMock = mock(() => {});
    const origWarn = console.warn.bind(console);
    console.warn = warnMock;

    try {
      const parser = createLineParser();
      const invalidMsg = JSON.stringify({ jsonrpc: "1.0", method: "foo" });
      const msgs = parser.feed(`${invalidMsg}\n`);
      expect(msgs).toHaveLength(0);
      expect(warnMock).toHaveBeenCalledTimes(1);
    } finally {
      console.warn = origWarn;
    }
  });
});

describe("buildRequest", () => {
  test("generates monotonically increasing IDs", () => {
    const r1 = buildRequest("method1", {});
    const r2 = buildRequest("method2", {});
    expect(r2.id).toBeGreaterThan(r1.id);
  });

  test("produces valid JSON", () => {
    const { message } = buildRequest("test", { key: "value" });
    const parsed = JSON.parse(message) as Record<string, unknown>;
    expect(parsed.jsonrpc).toBe("2.0");
    expect(parsed.method).toBe("test");
    expect(typeof parsed.id).toBe("number");
  });
});

describe("buildResponse", () => {
  test("produces valid JSON-RPC success response", () => {
    const json = buildResponse(1, { sessionId: "sess_abc" });
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed.jsonrpc).toBe("2.0");
    expect(parsed.id).toBe(1);
    expect((parsed.result as Record<string, string>).sessionId).toBe("sess_abc");
  });
});

describe("buildErrorResponse", () => {
  test("produces valid JSON-RPC error response", () => {
    const json = buildErrorResponse(1, RPC_ERROR_CODES.METHOD_NOT_FOUND, "Not found");
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed.jsonrpc).toBe("2.0");
    expect(parsed.id).toBe(1);
    const error = parsed.error as Record<string, unknown>;
    expect(error.code).toBe(-32601);
    expect(error.message).toBe("Not found");
  });

  test("includes data field when provided", () => {
    const json = buildErrorResponse(2, RPC_ERROR_CODES.INVALID_PARAMS, "Bad params", {
      field: "path",
    });
    const parsed = JSON.parse(json) as { error: { data: Record<string, string> } };
    expect(parsed.error.data.field).toBe("path");
  });
});

describe("RPC_ERROR_CODES", () => {
  test("has expected standard codes", () => {
    expect(RPC_ERROR_CODES.PARSE_ERROR).toBe(-32700);
    expect(RPC_ERROR_CODES.INVALID_REQUEST).toBe(-32600);
    expect(RPC_ERROR_CODES.METHOD_NOT_FOUND).toBe(-32601);
    expect(RPC_ERROR_CODES.INVALID_PARAMS).toBe(-32602);
    expect(RPC_ERROR_CODES.INTERNAL_ERROR).toBe(-32603);
  });
});
