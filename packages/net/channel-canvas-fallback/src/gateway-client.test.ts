/**
 * Tests for the Gateway canvas HTTP client.
 *
 * Uses Bun.serve() as a mock Gateway server.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createGatewayClient } from "./gateway-client.js";

// ---------------------------------------------------------------------------
// Mock server
// ---------------------------------------------------------------------------

type MockHandler = (req: Request) => Response | Promise<Response>;

// let: re-assigned per test to swap handler logic
let currentHandler: MockHandler = () => new Response("not configured", { status: 500 });

// let: server lifecycle — created in beforeEach, stopped in afterEach
let server: ReturnType<typeof Bun.serve>;
// let: resolved after server starts
let baseUrl: string;

beforeEach(() => {
  server = Bun.serve({
    port: 0,
    fetch(req: Request) {
      return currentHandler(req);
    },
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterEach(() => {
  server.stop(true);
});

// ---------------------------------------------------------------------------
// createSurface
// ---------------------------------------------------------------------------

describe("createSurface", () => {
  test("POST success returns surfaceId", async () => {
    currentHandler = (req) => {
      if (req.method !== "POST") return new Response("bad method", { status: 405 });
      return new Response(JSON.stringify({ ok: true, surfaceId: "s1" }), {
        status: 201,
        headers: { "Content-Type": "application/json", ETag: '"abc"' },
      });
    };

    const client = createGatewayClient({ canvasBaseUrl: baseUrl });
    const result = await client.createSurface("s1", '{"kind":"createSurface"}');
    expect(result).toEqual({ ok: true, value: { surfaceId: "s1" } });
  });

  test("POST 409 conflict returns CONFLICT error", async () => {
    currentHandler = () =>
      new Response(JSON.stringify({ ok: false, error: "exists" }), { status: 409 });

    const client = createGatewayClient({ canvasBaseUrl: baseUrl });
    const result = await client.createSurface("s1", "{}");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFLICT");
    }
  });

  test("POST 500 error returns EXTERNAL error with retryable true", async () => {
    currentHandler = () => new Response("boom", { status: 500 });

    const client = createGatewayClient({ canvasBaseUrl: baseUrl });
    const result = await client.createSurface("s1", "{}");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.retryable).toBe(true);
    }
  });

  test("sends Authorization header when authToken is configured", async () => {
    // let: captured in handler closure
    let capturedAuth = "";
    currentHandler = (req) => {
      capturedAuth = req.headers.get("Authorization") ?? "";
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    };

    const client = createGatewayClient({ canvasBaseUrl: baseUrl, authToken: "tok123" });
    await client.createSurface("s1", "{}");
    expect(capturedAuth).toBe("Bearer tok123");
  });

  test("network failure returns EXTERNAL error", async () => {
    const client = createGatewayClient({
      canvasBaseUrl: "http://localhost:1", // unlikely to be listening
      timeoutMs: 500,
    });
    const result = await client.createSurface("s1", "{}");
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// updateSurface
// ---------------------------------------------------------------------------

describe("updateSurface", () => {
  test("PATCH success returns surfaceId", async () => {
    currentHandler = (req) => {
      if (req.method !== "PATCH") return new Response("bad method", { status: 405 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const client = createGatewayClient({ canvasBaseUrl: baseUrl });
    const result = await client.updateSurface("s1", '{"content":"updated"}');
    expect(result).toEqual({ ok: true, value: { surfaceId: "s1" } });
  });

  test("PATCH 404 returns NOT_FOUND error", async () => {
    currentHandler = () => new Response("not found", { status: 404 });

    const client = createGatewayClient({ canvasBaseUrl: baseUrl });
    const result = await client.updateSurface("s1", "{}");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });
});

// ---------------------------------------------------------------------------
// deleteSurface
// ---------------------------------------------------------------------------

describe("deleteSurface", () => {
  test("DELETE 204 returns true", async () => {
    currentHandler = (req) => {
      if (req.method !== "DELETE") return new Response("bad method", { status: 405 });
      return new Response(null, { status: 204 });
    };

    const client = createGatewayClient({ canvasBaseUrl: baseUrl });
    const result = await client.deleteSurface("s1");
    expect(result).toEqual({ ok: true, value: true });
  });

  test("DELETE 404 is idempotent — returns false", async () => {
    currentHandler = () => new Response("not found", { status: 404 });

    const client = createGatewayClient({ canvasBaseUrl: baseUrl });
    const result = await client.deleteSurface("s1");
    expect(result).toEqual({ ok: true, value: false });
  });
});

// ---------------------------------------------------------------------------
// computeSurfaceUrl
// ---------------------------------------------------------------------------

describe("computeSurfaceUrl", () => {
  test("returns correct URL", () => {
    const client = createGatewayClient({ canvasBaseUrl: "http://gw:3000/gateway/canvas" });
    expect(client.computeSurfaceUrl("s1")).toBe("http://gw:3000/gateway/canvas/s1");
  });

  test("strips trailing slash from base URL", () => {
    const client = createGatewayClient({ canvasBaseUrl: "http://gw:3000/gateway/canvas/" });
    expect(client.computeSurfaceUrl("s1")).toBe("http://gw:3000/gateway/canvas/s1");
  });
});

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

describe("timeout", () => {
  test("times out on slow server", async () => {
    currentHandler = async () => {
      await Bun.sleep(5_000);
      return new Response("slow", { status: 200 });
    };

    const client = createGatewayClient({ canvasBaseUrl: baseUrl, timeoutMs: 100 });
    const result = await client.createSurface("s1", "{}");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
      expect(result.error.retryable).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Injectable fetch
// ---------------------------------------------------------------------------

describe("injectable fetch", () => {
  test("uses injected fetch instead of globalThis.fetch", async () => {
    const injectedFetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 201 })),
    );

    const client = createGatewayClient({
      canvasBaseUrl: "http://test:3000/canvas",
      fetch: injectedFetch as unknown as typeof globalThis.fetch,
    });
    const result = await client.createSurface("s1", "{}");

    expect(result.ok).toBe(true);
    expect(injectedFetch).toHaveBeenCalledTimes(1);
    const [url] = injectedFetch.mock.calls[0] as unknown as [string];
    expect(url).toBe("http://test:3000/canvas/s1");
  });
});
