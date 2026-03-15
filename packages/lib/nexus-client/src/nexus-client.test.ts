import { describe, expect, test } from "bun:test";
import { mapHttpError, mapRpcError } from "./errors.js";
import { createNexusClient } from "./nexus-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockFetch(
  handler: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof globalThis.fetch {
  return handler as typeof globalThis.fetch;
}

function jsonResponse<T>(result: T, id = 1): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function rpcErrorResponse(code: number, message: string, id = 1): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// createNexusClient
// ---------------------------------------------------------------------------

describe("createNexusClient", () => {
  test("sends JSON-RPC 2.0 request with correct headers", async () => {
    let capturedInit: RequestInit | undefined;
    let capturedUrl: string | URL | Request | undefined;

    const client = createNexusClient({
      baseUrl: "http://localhost:2026",
      apiKey: "test-key",
      fetch: createMockFetch(async (url, init) => {
        capturedUrl = url;
        capturedInit = init;
        return jsonResponse("ok");
      }),
    });

    await client.rpc("test.method", { foo: "bar" });

    expect(capturedUrl).toBe("http://localhost:2026/api/nfs/test.method");
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer test-key",
    });

    const body = JSON.parse(capturedInit?.body as string) as Record<string, unknown>;
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(body.method).toBe("test.method");
    expect(body.params).toEqual({ foo: "bar" });
  });

  test("returns successful result", async () => {
    const client = createNexusClient({
      baseUrl: "http://localhost:2026",
      apiKey: "test-key",
      fetch: createMockFetch(async () => jsonResponse({ data: 42 })),
    });

    const result = await client.rpc<{ readonly data: number }>("test.get", {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.data).toBe(42);
    }
  });

  test("generates monotonically increasing request IDs", async () => {
    const ids: number[] = [];

    const client = createNexusClient({
      baseUrl: "http://localhost:2026",
      apiKey: "test-key",
      fetch: createMockFetch(async (_url, init) => {
        const body = JSON.parse(init?.body as string) as { readonly id: number };
        ids.push(body.id);
        return jsonResponse("ok");
      }),
    });

    await client.rpc("a", {});
    await client.rpc("b", {});
    await client.rpc("c", {});

    expect(ids).toEqual([1, 2, 3]);
  });

  test("maps HTTP error status to KoiError", async () => {
    const client = createNexusClient({
      baseUrl: "http://localhost:2026",
      apiKey: "test-key",
      fetch: createMockFetch(async () => new Response("not found", { status: 404 })),
    });

    const result = await client.rpc("test", {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("maps JSON-RPC error to KoiError", async () => {
    const client = createNexusClient({
      baseUrl: "http://localhost:2026",
      apiKey: "test-key",
      fetch: createMockFetch(async () => rpcErrorResponse(-32601, "method not found")),
    });

    const result = await client.rpc("unknown.method", {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.message).toContain("RPC method not found");
      expect(result.error.retryable).toBe(false);
    }
  });

  test("handles network failures", async () => {
    const client = createNexusClient({
      baseUrl: "http://localhost:2026",
      apiKey: "test-key",
      fetch: createMockFetch(async () => {
        throw new Error("ECONNREFUSED");
      }),
    });

    const result = await client.rpc("test", {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.message).toContain("ECONNREFUSED");
      expect(result.error.retryable).toBe(true);
    }
  });

  test("handles malformed JSON response", async () => {
    const client = createNexusClient({
      baseUrl: "http://localhost:2026",
      apiKey: "test-key",
      fetch: createMockFetch(async () => new Response("not json", { status: 200 })),
    });

    const result = await client.rpc("test", {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL");
      expect(result.error.retryable).toBe(false);
    }
  });

  test("returns error for malformed JSON-RPC response without result or error", async () => {
    const client = createNexusClient({
      baseUrl: "http://localhost:2026",
      apiKey: "test-key",
      fetch: createMockFetch(
        async () =>
          new Response(JSON.stringify({ jsonrpc: "2.0", id: 1 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    });

    const result = await client.rpc("test", {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL");
      expect(result.error.message).toContain("missing result");
    }
  });

  test("uses globalThis.fetch when no fetch provided", () => {
    // Just verifying it doesn't throw during construction
    const client = createNexusClient({
      baseUrl: "http://localhost:2026",
      apiKey: "test-key",
    });

    expect(client.rpc).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// mapHttpError
// ---------------------------------------------------------------------------

describe("mapHttpError", () => {
  test("maps 404 to NOT_FOUND", () => {
    const error = mapHttpError(404, "not found");
    expect(error.code).toBe("NOT_FOUND");
    expect(error.retryable).toBe(false);
  });

  test("maps 401 to PERMISSION", () => {
    const error = mapHttpError(401, "unauthorized");
    expect(error.code).toBe("PERMISSION");
    expect(error.retryable).toBe(false);
  });

  test("maps 403 to PERMISSION", () => {
    const error = mapHttpError(403, "forbidden");
    expect(error.code).toBe("PERMISSION");
    expect(error.retryable).toBe(false);
  });

  test("maps 409 to CONFLICT", () => {
    const error = mapHttpError(409, "conflict");
    expect(error.code).toBe("CONFLICT");
    expect(error.retryable).toBe(true);
  });

  test("maps 429 to RATE_LIMIT", () => {
    const error = mapHttpError(429, "rate limit");
    expect(error.code).toBe("RATE_LIMIT");
    expect(error.retryable).toBe(true);
  });

  test("maps unknown status to EXTERNAL with retryable true", () => {
    const error = mapHttpError(500, "internal");
    expect(error.code).toBe("EXTERNAL");
    expect(error.retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mapRpcError
// ---------------------------------------------------------------------------

describe("mapRpcError", () => {
  test("maps -32601 to non-retryable EXTERNAL", () => {
    const error = mapRpcError({ code: -32601, message: "method not found" });
    expect(error.code).toBe("EXTERNAL");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("RPC method not found");
  });

  test("maps other codes to retryable EXTERNAL", () => {
    const error = mapRpcError({ code: -32600, message: "invalid request" });
    expect(error.code).toBe("EXTERNAL");
    expect(error.retryable).toBe(true);
    expect(error.message).toBe("invalid request");
  });
});
