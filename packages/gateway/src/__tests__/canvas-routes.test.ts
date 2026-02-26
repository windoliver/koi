import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Result } from "@koi/core";
import type { CanvasAuthenticator, CanvasAuthResult, CanvasServer } from "../canvas-routes.js";
import { createCanvasServer } from "../canvas-routes.js";
import type { CanvasSseManager } from "../canvas-sse.js";
import { createCanvasSseManager } from "../canvas-sse.js";
import type { SurfaceStore } from "../canvas-store.js";
import { createInMemorySurfaceStore } from "../canvas-store.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const PREFIX = "/gateway/canvas";

function url(server: CanvasServer, path: string): string {
  return `http://localhost:${server.port()}${PREFIX}${path}`;
}

/** Default authenticator that accepts any Bearer token. */
const acceptAllAuth: CanvasAuthenticator = async (
  request: Request,
): Promise<Result<CanvasAuthResult>> => {
  const header = request.headers.get("Authorization");
  if (header === null || !header.startsWith("Bearer ")) {
    return { ok: false, error: { code: "PERMISSION", message: "Unauthorized", retryable: false } };
  }
  return { ok: true, value: { agentId: "test-agent" } };
};

function authHeaders(): Record<string, string> {
  return { Authorization: "Bearer test-token", "Content-Type": "application/json" };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("canvas routes", () => {
  let store: SurfaceStore;
  let sse: CanvasSseManager;
  let server: CanvasServer;

  beforeEach(async () => {
    store = createInMemorySurfaceStore();
    sse = createCanvasSseManager({ keepAliveIntervalMs: 60_000 });
    server = createCanvasServer(
      { port: 0, pathPrefix: PREFIX, maxBodyBytes: 1024 },
      store,
      sse,
      acceptAllAuth,
    );
    await server.start();
  });

  afterEach(() => {
    server.stop();
    sse.dispose();
  });

  // -------------------------------------------------------------------
  // POST (create)
  // -------------------------------------------------------------------

  test("POST creates surface → 201 + ETag + Location", async () => {
    const res = await fetch(url(server, "/test-1"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ content: "hello world" }),
    });

    expect(res.status).toBe(201);
    expect(res.headers.get("ETag")).toBeTruthy();
    expect(res.headers.get("Location")).toBe(`${PREFIX}/test-1`);

    const body = (await res.json()) as { ok: boolean; surfaceId: string };
    expect(body.ok).toBe(true);
    expect(body.surfaceId).toBe("test-1");
  });

  test("POST duplicate → 409 Conflict", async () => {
    await fetch(url(server, "/dup"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ content: "v1" }),
    });

    const res = await fetch(url(server, "/dup"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ content: "v2" }),
    });

    expect(res.status).toBe(409);
  });

  test("POST without auth → 401", async () => {
    const res = await fetch(url(server, "/no-auth"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "test" }),
    });

    expect(res.status).toBe(401);
  });

  test("POST with invalid body → 400", async () => {
    const res = await fetch(url(server, "/bad-body"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ wrong: "field" }),
    });

    expect(res.status).toBe(400);
  });

  // -------------------------------------------------------------------
  // GET (read)
  // -------------------------------------------------------------------

  test("GET existing → 200 + content + ETag", async () => {
    await fetch(url(server, "/read-1"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ content: "hello" }),
    });

    const res = await fetch(url(server, "/read-1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBeTruthy();

    const body = (await res.json()) as { ok: boolean; surface: { content: string } };
    expect(body.ok).toBe(true);
    expect(body.surface.content).toBe("hello");
  });

  test("GET nonexistent → 404", async () => {
    const res = await fetch(url(server, "/nope"));
    expect(res.status).toBe(404);
  });

  test("GET with matching If-None-Match → 304", async () => {
    const createRes = await fetch(url(server, "/etag-1"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ content: "hello" }),
    });
    const etag = createRes.headers.get("ETag") ?? "";

    const res = await fetch(url(server, "/etag-1"), {
      headers: { "If-None-Match": etag },
    });
    expect(res.status).toBe(304);
  });

  test("GET with non-matching If-None-Match → 200", async () => {
    await fetch(url(server, "/etag-2"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ content: "hello" }),
    });

    const res = await fetch(url(server, "/etag-2"), {
      headers: { "If-None-Match": '"stale-hash"' },
    });
    expect(res.status).toBe(200);
  });

  test("GET does not require auth", async () => {
    await fetch(url(server, "/public"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ content: "public data" }),
    });

    // No auth headers
    const res = await fetch(url(server, "/public"));
    expect(res.status).toBe(200);
  });

  // -------------------------------------------------------------------
  // PATCH (update)
  // -------------------------------------------------------------------

  test("PATCH with If-Match → 200 + new ETag", async () => {
    const createRes = await fetch(url(server, "/patch-1"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ content: "v1" }),
    });
    const etag = createRes.headers.get("ETag") ?? "";

    const res = await fetch(url(server, "/patch-1"), {
      method: "PATCH",
      headers: { ...authHeaders(), "If-Match": etag },
      body: JSON.stringify({ content: "v2" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBeTruthy();
    expect(res.headers.get("ETag")).not.toBe(etag);
  });

  test("PATCH with stale If-Match → 412", async () => {
    await fetch(url(server, "/patch-2"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ content: "v1" }),
    });

    const res = await fetch(url(server, "/patch-2"), {
      method: "PATCH",
      headers: { ...authHeaders(), "If-Match": '"stale-hash"' },
      body: JSON.stringify({ content: "v2" }),
    });

    expect(res.status).toBe(412);
  });

  test("PATCH without If-Match → 200 (unconditional)", async () => {
    await fetch(url(server, "/patch-3"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ content: "v1" }),
    });

    const res = await fetch(url(server, "/patch-3"), {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ content: "v2" }),
    });

    expect(res.status).toBe(200);
  });

  test("PATCH nonexistent → 404", async () => {
    const res = await fetch(url(server, "/nope"), {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ content: "v1" }),
    });

    expect(res.status).toBe(404);
  });

  test("PATCH without auth → 401", async () => {
    const res = await fetch(url(server, "/no-auth"), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "v1" }),
    });

    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------
  // DELETE
  // -------------------------------------------------------------------

  test("DELETE existing → 204", async () => {
    await fetch(url(server, "/del-1"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ content: "v1" }),
    });

    const res = await fetch(url(server, "/del-1"), {
      method: "DELETE",
      headers: { Authorization: "Bearer test-token" },
    });

    expect(res.status).toBe(204);
  });

  test("DELETE nonexistent → 404", async () => {
    const res = await fetch(url(server, "/nope"), {
      method: "DELETE",
      headers: { Authorization: "Bearer test-token" },
    });

    expect(res.status).toBe(404);
  });

  test("DELETE without auth → 401", async () => {
    const res = await fetch(url(server, "/no-auth"), {
      method: "DELETE",
    });

    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------
  // Body size limit
  // -------------------------------------------------------------------

  test("POST body exceeding maxBodyBytes → 413", async () => {
    const largeContent = "x".repeat(2048);
    const res = await fetch(url(server, "/big"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ content: largeContent }),
    });

    expect(res.status).toBe(413);
  });

  // -------------------------------------------------------------------
  // Path / method edge cases
  // -------------------------------------------------------------------

  test("wrong path → 404", async () => {
    const res = await fetch(`http://localhost:${server.port()}/wrong/path`);
    expect(res.status).toBe(404);
  });

  test("unsupported method → 405", async () => {
    const res = await fetch(url(server, "/test"), {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ content: "v1" }),
    });

    expect(res.status).toBe(405);
  });

  test("missing surface ID → 404", async () => {
    const res = await fetch(`http://localhost:${server.port()}${PREFIX}`);
    expect(res.status).toBe(404);
  });

  test("invalid surface ID → 400", async () => {
    // Spaces, slashes, and special chars are rejected
    const res = await fetch(url(server, "/invalid%20id"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ content: "v1" }),
    });
    expect(res.status).toBe(400);
  });

  test("surface ID exceeding 128 chars → 400", async () => {
    const longId = "a".repeat(129);
    const res = await fetch(url(server, `/${longId}`), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ content: "v1" }),
    });
    expect(res.status).toBe(400);
  });

  // -------------------------------------------------------------------
  // SSE endpoint
  // -------------------------------------------------------------------

  test("SSE for nonexistent surface → 404", async () => {
    const res = await fetch(url(server, "/nope/events"));
    expect(res.status).toBe(404);
  });

  test("SSE endpoint returns text/event-stream", async () => {
    await fetch(url(server, "/sse-1"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ content: "v1" }),
    });

    const controller = new AbortController();
    const res = await fetch(url(server, "/sse-1/events"), {
      signal: controller.signal,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    controller.abort();
  });

  test("SSE does not require auth", async () => {
    await fetch(url(server, "/sse-pub"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ content: "v1" }),
    });

    // No auth headers
    const controller = new AbortController();
    const res = await fetch(url(server, "/sse-pub/events"), {
      signal: controller.signal,
    });

    expect(res.status).toBe(200);
    controller.abort();
  });

  // -------------------------------------------------------------------
  // Server without authenticator (all writes fail)
  // -------------------------------------------------------------------

  test("server without authenticator rejects all writes", async () => {
    const noAuthServer = createCanvasServer(
      { port: 0, pathPrefix: PREFIX },
      store,
      sse,
      // No authenticator
    );
    await noAuthServer.start();

    try {
      const res = await fetch(`http://localhost:${noAuthServer.port()}${PREFIX}/test`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ content: "v1" }),
      });
      expect(res.status).toBe(401);
    } finally {
      noAuthServer.stop();
    }
  });

  // -------------------------------------------------------------------
  // POST with metadata
  // -------------------------------------------------------------------

  test("POST with metadata preserves it", async () => {
    await fetch(url(server, "/meta-1"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ content: "hello", metadata: { author: "test" } }),
    });

    const res = await fetch(url(server, "/meta-1"));
    const body = (await res.json()) as { surface: { metadata: Record<string, unknown> } };
    expect(body.surface.metadata).toEqual({ author: "test" });
  });
});
