import { describe, expect, test } from "bun:test";
import { mapNexusError } from "./errors.js";
import { createHttpTransport } from "./transport.js";
import type { FetchFn } from "./types.js";

function makeFetchThatReturns(body: unknown, status = 200): FetchFn {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

describe("createHttpTransport", () => {
  test("returns result value on success", async () => {
    const transport = createHttpTransport({
      url: "http://nexus.test",
      fetch: makeFetchThatReturns({ jsonrpc: "2.0", id: 1, result: "hello" }),
    });
    const result = await transport.call<string>("read", { path: "foo" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("hello");
    transport.close();
  });

  test("returns error on JSON-RPC error response", async () => {
    const transport = createHttpTransport({
      url: "http://nexus.test",
      fetch: makeFetchThatReturns({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32000, message: "not found" },
      }),
    });
    const result = await transport.call<string>("read", { path: "missing" });
    expect(result.ok).toBe(false);
    transport.close();
  });

  test("returns EXTERNAL error on HTTP 4xx", async () => {
    const transport = createHttpTransport({
      url: "http://nexus.test",
      fetch: makeFetchThatReturns({ error: "forbidden" }, 403),
    });
    const result = await transport.call<string>("read", { path: "secret" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("EXTERNAL");
    transport.close();
  });

  test("sends Authorization header when apiKey provided", async () => {
    let capturedAuth: string | undefined;
    const fetchSpy: FetchFn = async (_input, init) => {
      const headers = (init?.headers as Record<string, string> | undefined) ?? {};
      capturedAuth = headers.Authorization;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }), {
        headers: { "Content-Type": "application/json" },
      });
    };
    const transport = createHttpTransport({
      url: "http://nexus.test",
      apiKey: "sk-test",
      fetch: fetchSpy,
    });
    await transport.call("read", { path: "x" });
    expect(capturedAuth).toBe("Bearer sk-test");
    transport.close();
  });

  test("does not send Authorization header when no apiKey", async () => {
    let capturedAuth: string | undefined;
    const fetchSpy: FetchFn = async (_input, init) => {
      const headers = (init?.headers as Record<string, string> | undefined) ?? {};
      capturedAuth = headers.Authorization;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }), {
        headers: { "Content-Type": "application/json" },
      });
    };
    const transport = createHttpTransport({ url: "http://nexus.test", fetch: fetchSpy });
    await transport.call("read", { path: "x" });
    expect(capturedAuth).toBeUndefined();
    transport.close();
  });

  test("returns RATE_LIMIT on HTTP 429", async () => {
    const transport = createHttpTransport({
      url: "http://nexus.test",
      retries: 0,
      fetch: makeFetchThatReturns({ error: "too many requests" }, 429),
    });
    const result = await transport.call<string>("write", { path: "x", content: "y" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("RATE_LIMIT");
    transport.close();
  });

  test("returns INTERNAL on HTTP 500", async () => {
    const transport = createHttpTransport({
      url: "http://nexus.test",
      retries: 0,
      fetch: makeFetchThatReturns({ error: "server error" }, 500),
    });
    // Use non-retryable method to avoid retry delay
    const result = await transport.call<string>("write", { path: "x", content: "y" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INTERNAL");
    transport.close();
  });

  test("returns TIMEOUT on TypeError (network error)", async () => {
    const fetchSpy: FetchFn = async () => {
      throw new TypeError("Failed to fetch");
    };
    const transport = createHttpTransport({ url: "http://nexus.test", fetch: fetchSpy });
    const result = await transport.call<string>("write", { path: "x", content: "y" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TIMEOUT");
    transport.close();
  });

  test("retries retryable method on 500 and eventually returns error", async () => {
    let attempts = 0;
    const fetchSpy: FetchFn = async () => {
      attempts++;
      return new Response(JSON.stringify({ error: "server error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    };
    const transport = createHttpTransport({
      url: "http://nexus.test",
      fetch: fetchSpy,
      retries: 1,
      deadlineMs: 5_000,
    });
    const result = await transport.call<string>("read", { path: "x" });
    expect(result.ok).toBe(false);
    // Should attempt initial + 1 retry = 2 times
    expect(attempts).toBe(2);
    transport.close();
  });

  test("non-retryable method does not retry on 500", async () => {
    let attempts = 0;
    const fetchSpy: FetchFn = async () => {
      attempts++;
      return new Response(JSON.stringify({ error: "server error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    };
    const transport = createHttpTransport({
      url: "http://nexus.test",
      fetch: fetchSpy,
      retries: 2,
    });
    // "write" is not in RETRYABLE_METHODS
    const result = await transport.call<string>("write", { path: "x", content: "y" });
    expect(result.ok).toBe(false);
    expect(attempts).toBe(1);
    transport.close();
  });
});

describe("mapNexusError", () => {
  test("maps AbortError DOMException to non-retryable TIMEOUT", () => {
    // Aborts are intentional — never retryable. Retrying would defeat the
    // cancellation contract and could loop until the next deadline fires.
    const err = new DOMException("aborted", "AbortError");
    const result = mapNexusError(err, "read");
    expect(result.code).toBe("TIMEOUT");
    expect(result.retryable).toBe(false);
  });

  test("maps generic Error to EXTERNAL with retryable true", () => {
    const err = new Error("something failed");
    const result = mapNexusError(err, "list");
    expect(result.code).toBe("EXTERNAL");
    expect(result.retryable).toBe(true);
  });

  test("maps non-Error value to EXTERNAL with retryable false", () => {
    const result = mapNexusError("unexpected string", "read");
    expect(result.code).toBe("EXTERNAL");
    expect(result.retryable).toBe(false);
  });

  test("maps RPC error object to EXTERNAL with retryable false", () => {
    const result = mapNexusError({ code: -32600, message: "Invalid Request" }, "read");
    expect(result.code).toBe("EXTERNAL");
    expect(result.retryable).toBe(false);
  });
});
