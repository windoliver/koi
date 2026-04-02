/**
 * Tests for the HTTP JSON-RPC transport.
 */

import { describe, expect, test } from "bun:test";
import { createHttpTransport } from "./http-transport.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockFetch(handler: (body: unknown) => unknown): typeof globalThis.fetch {
  const fetchFn = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(init?.body as string) as unknown;
    const result = handler(body);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return Object.assign(fetchFn, {
    preconnect: (_url: string | URL, _options?: unknown) => {},
  }) satisfies typeof globalThis.fetch;
}

function createErrorFetch(status: number, statusText: string): typeof globalThis.fetch {
  const fetchFn = async (): Promise<Response> => {
    return new Response(null, { status, statusText });
  };
  return Object.assign(fetchFn, {
    preconnect: (_url: string | URL, _options?: unknown) => {},
  }) satisfies typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createHttpTransport", () => {
  test("sends JSON-RPC request and returns result", async () => {
    const mockFetch = createMockFetch((body) => {
      const req = body as { readonly method: string; readonly params: Record<string, unknown> };
      expect(req.method).toBe("read");
      return { jsonrpc: "2.0", id: 1, result: { content: "hello", path: "/test.txt", size: 5 } };
    });

    const transport = createHttpTransport({
      url: "http://localhost:3100",
      fetch: mockFetch,
    });

    const result = await transport.call<{ readonly content: string }>("read", {
      path: "/fs/test.txt",
    });
    expect(result.content).toBe("hello");
  });

  test("RPC error throws", async () => {
    const mockFetch = createMockFetch(() => ({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32600, message: "Invalid request" },
    }));

    const transport = createHttpTransport({
      url: "http://localhost:3100",
      fetch: mockFetch,
    });

    await expect(transport.call("bad", {})).rejects.toThrow("Invalid request");
  });

  test("HTTP error throws", async () => {
    const mockFetch = createErrorFetch(500, "Internal Server Error");
    const transport = createHttpTransport({
      url: "http://localhost:3100",
      fetch: mockFetch,
    });

    await expect(transport.call("read", {})).rejects.toThrow("500");
  });

  test("closed transport rejects calls", async () => {
    const mockFetch = createMockFetch(() => ({ jsonrpc: "2.0", id: 1, result: null }));
    const transport = createHttpTransport({
      url: "http://localhost:3100",
      fetch: mockFetch,
    });

    await transport.close();
    await expect(transport.call("read", {})).rejects.toThrow("closed");
  });

  test("increments request IDs", async () => {
    const ids: number[] = [];
    const mockFetch = createMockFetch((body) => {
      const req = body as { readonly id: number };
      ids.push(req.id);
      return { jsonrpc: "2.0", id: req.id, result: null };
    });

    const transport = createHttpTransport({
      url: "http://localhost:3100",
      fetch: mockFetch,
    });

    await transport.call("a", {});
    await transport.call("b", {});
    expect(ids).toEqual([1, 2]);
  });
});
