import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Result } from "@koi/core";

import { createCanvasServer } from "../canvas-routes.js";
import { createCanvasSseManager } from "../canvas-sse.js";
import { createInMemorySurfaceStore } from "../canvas-store.js";
import type {
  CanvasAuthenticator,
  CanvasAuthResult,
  CanvasServer,
  CanvasSseManager,
  SurfaceStore,
} from "../types.js";

const PREFIX = "/gateway/canvas";

function url(server: CanvasServer, path: string): string {
  return `http://localhost:${server.port()}${PREFIX}${path}`;
}

/**
 * Treats the bearer token as the agentId so tests can simulate distinct
 * tenants by varying the token. e.g. `Bearer alice` → agentId "alice".
 */
const tokenAsAgent: CanvasAuthenticator = async (request): Promise<Result<CanvasAuthResult>> => {
  const header = request.headers.get("Authorization");
  if (header === null || !header.startsWith("Bearer ")) {
    return {
      ok: false,
      error: { code: "PERMISSION", message: "Unauthorized", retryable: false },
    };
  }
  return { ok: true, value: { agentId: header.slice("Bearer ".length) } };
};

function authHeaders(token = "test-agent"): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

describe("canvas routes", () => {
  // let: rebuilt per test in beforeEach
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
      tokenAsAgent,
    );
    await server.start();
  });

  afterEach(() => {
    server.stop();
    sse.dispose();
  });

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

  test("POST duplicate → 409", async () => {
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

  test("GET existing → 200 + content + ETag", async () => {
    await fetch(url(server, "/read-1"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ content: "hello" }),
    });

    const res = await fetch(url(server, "/read-1"), { headers: authHeaders() });
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBeTruthy();

    const body = (await res.json()) as { ok: boolean; surface: { content: string } };
    expect(body.ok).toBe(true);
    expect(body.surface.content).toBe("hello");
  });

  test("GET nonexistent → 404", async () => {
    const res = await fetch(url(server, "/nope"), { headers: authHeaders() });
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
      headers: { ...authHeaders(), "If-None-Match": etag },
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
      headers: { ...authHeaders(), "If-None-Match": '"stale-hash"' },
    });
    expect(res.status).toBe(200);
  });

  test("GET without auth → 401", async () => {
    await fetch(url(server, "/private"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ content: "private data" }),
    });

    const res = await fetch(url(server, "/private"));
    expect(res.status).toBe(401);
  });

  test("GET by non-owner → 404 (cross-tenant read isolation)", async () => {
    await fetch(url(server, "/own-r"), {
      method: "POST",
      headers: authHeaders("alice"),
      body: JSON.stringify({ content: "secret" }),
    });

    const res = await fetch(url(server, "/own-r"), { headers: authHeaders("mallory") });
    expect(res.status).toBe(404);
  });

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

  test("PATCH without If-Match → 428 Precondition Required (generation fence)", async () => {
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

    expect(res.status).toBe(428);
  });

  test("PATCH nonexistent → 404", async () => {
    const res = await fetch(url(server, "/nope"), {
      method: "PATCH",
      headers: { ...authHeaders(), "If-Match": '"any"' },
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

  test("DELETE existing → 204", async () => {
    const create = await fetch(url(server, "/del-1"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ content: "v1" }),
    });
    const etag = create.headers.get("ETag") ?? "";

    const res = await fetch(url(server, "/del-1"), {
      method: "DELETE",
      headers: { Authorization: "Bearer test-agent", "If-Match": etag },
    });

    expect(res.status).toBe(204);
  });

  test("DELETE nonexistent → 404", async () => {
    const res = await fetch(url(server, "/nope"), {
      method: "DELETE",
      headers: { Authorization: "Bearer test-agent", "If-Match": '"any"' },
    });

    expect(res.status).toBe(404);
  });

  test("DELETE without auth → 401", async () => {
    const res = await fetch(url(server, "/no-auth"), {
      method: "DELETE",
      headers: { "If-Match": '"any"' },
    });
    expect(res.status).toBe(401);
  });

  test("DELETE without If-Match → 428 Precondition Required", async () => {
    await fetch(url(server, "/del-fence"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ content: "v1" }),
    });

    const res = await fetch(url(server, "/del-fence"), {
      method: "DELETE",
      headers: { Authorization: "Bearer test-agent" },
    });

    expect(res.status).toBe(428);
  });

  test("DELETE with stale If-Match → 412 (stops cross-generation wipe on retry)", async () => {
    const create = await fetch(url(server, "/del-stale"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ content: "v1" }),
    });
    const oldEtag = create.headers.get("ETag") ?? "";

    // Owner mutates the surface (etag changes)
    await fetch(url(server, "/del-stale"), {
      method: "PATCH",
      headers: { ...authHeaders(), "If-Match": oldEtag },
      body: JSON.stringify({ content: "v2" }),
    });

    // Replayed delete with old etag → 412, surface preserved
    const res = await fetch(url(server, "/del-stale"), {
      method: "DELETE",
      headers: { Authorization: "Bearer test-agent", "If-Match": oldEtag },
    });
    expect(res.status).toBe(412);

    const stillThere = await fetch(url(server, "/del-stale"), { headers: authHeaders() });
    expect(stillThere.status).toBe(200);
  });

  test("POST body exceeding maxBodyBytes → 413", async () => {
    const largeContent = "x".repeat(2048);
    const res = await fetch(url(server, "/big"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ content: largeContent }),
    });
    expect(res.status).toBe(413);
  });

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

  test("SSE for nonexistent surface → 404", async () => {
    const res = await fetch(url(server, "/nope/events"), { headers: authHeaders() });
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
      headers: authHeaders(),
      signal: controller.signal,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    controller.abort();
  });

  test("SSE without auth → 401", async () => {
    await fetch(url(server, "/sse-priv"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ content: "v1" }),
    });

    const controller = new AbortController();
    const res = await fetch(url(server, "/sse-priv/events"), { signal: controller.signal });
    expect(res.status).toBe(401);
    controller.abort();
  });

  test("SSE by non-owner → 404 (cross-tenant subscribe isolation)", async () => {
    await fetch(url(server, "/sse-own"), {
      method: "POST",
      headers: authHeaders("alice"),
      body: JSON.stringify({ content: "secret" }),
    });

    const controller = new AbortController();
    const res = await fetch(url(server, "/sse-own/events"), {
      headers: authHeaders("mallory"),
      signal: controller.signal,
    });
    expect(res.status).toBe(404);
    controller.abort();
  });

  test("server without authenticator rejects all writes", async () => {
    const noAuthServer = createCanvasServer({ port: 0, pathPrefix: PREFIX }, store, sse);
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

  test("POST with metadata preserves it", async () => {
    await fetch(url(server, "/meta-1"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ content: "hello", metadata: { author: "test" } }),
    });

    const res = await fetch(url(server, "/meta-1"), { headers: authHeaders() });
    const body = (await res.json()) as { surface: { metadata: Record<string, unknown> } };
    expect(body.surface.metadata).toEqual({ author: "test" });
  });

  test("PATCH by non-owner → 404 (cross-tenant isolation)", async () => {
    const create = await fetch(url(server, "/own-1"), {
      method: "POST",
      headers: authHeaders("alice"),
      body: JSON.stringify({ content: "v1" }),
    });
    const etag = create.headers.get("ETag") ?? "";

    const res = await fetch(url(server, "/own-1"), {
      method: "PATCH",
      headers: { ...authHeaders("mallory"), "If-Match": etag },
      body: JSON.stringify({ content: "v2" }),
    });

    expect(res.status).toBe(404);
  });

  test("DELETE by non-owner → 404 (cross-tenant isolation)", async () => {
    const create = await fetch(url(server, "/own-2"), {
      method: "POST",
      headers: authHeaders("alice"),
      body: JSON.stringify({ content: "v1" }),
    });
    const etag = create.headers.get("ETag") ?? "";

    const res = await fetch(url(server, "/own-2"), {
      method: "DELETE",
      headers: { Authorization: "Bearer mallory", "If-Match": etag },
    });

    expect(res.status).toBe(404);

    // Surface still belongs to alice
    const stillThere = await fetch(url(server, "/own-2"), { headers: authHeaders("alice") });
    expect(stillThere.status).toBe(200);
  });

  test("POST by non-owner on existing surface → 404 (no existence leak)", async () => {
    await fetch(url(server, "/probe"), {
      method: "POST",
      headers: authHeaders("alice"),
      body: JSON.stringify({ content: "v1" }),
    });

    const res = await fetch(url(server, "/probe"), {
      method: "POST",
      headers: authHeaders("mallory"),
      body: JSON.stringify({ content: "different" }),
    });

    // Mallory must NOT learn the surface exists. 404, not 409.
    expect(res.status).toBe(404);
  });

  test("POST by owner on own existing surface → 409 (real self-collision)", async () => {
    await fetch(url(server, "/self-dup"), {
      method: "POST",
      headers: authHeaders("alice"),
      body: JSON.stringify({ content: "v1" }),
    });

    const res = await fetch(url(server, "/self-dup"), {
      method: "POST",
      headers: authHeaders("alice"),
      body: JSON.stringify({ content: "v2" }),
    });

    expect(res.status).toBe(409);
  });

  test("PATCH by owner succeeds (ownership round-trip)", async () => {
    const create = await fetch(url(server, "/own-3"), {
      method: "POST",
      headers: authHeaders("alice"),
      body: JSON.stringify({ content: "v1" }),
    });
    const etag = create.headers.get("ETag") ?? "";

    const res = await fetch(url(server, "/own-3"), {
      method: "PATCH",
      headers: { ...authHeaders("alice"), "If-Match": etag },
      body: JSON.stringify({ content: "v2" }),
    });

    expect(res.status).toBe(200);
  });
});

describe("canvas routes — capacity & overload", () => {
  test("POST when store is full → 503 RESOURCE_EXHAUSTED with Retry-After", async () => {
    const store = createInMemorySurfaceStore({ maxSurfaces: 1 });
    const sse = createCanvasSseManager({ keepAliveIntervalMs: 60_000 });
    const server = createCanvasServer({ port: 0, pathPrefix: PREFIX }, store, sse, tokenAsAgent);
    await server.start();
    try {
      // Fill the store
      const first = await fetch(url(server, "/cap-1"), {
        method: "POST",
        headers: authHeaders("alice"),
        body: JSON.stringify({ content: "v1" }),
      });
      expect(first.status).toBe(201);

      // Next create exceeds capacity → 503 (no silent eviction)
      const overflow = await fetch(url(server, "/cap-2"), {
        method: "POST",
        headers: authHeaders("alice"),
        body: JSON.stringify({ content: "v2" }),
      });
      expect(overflow.status).toBe(503);
      expect(overflow.headers.get("Retry-After")).toBe("30");

      // Original surface untouched
      const stillThere = await fetch(url(server, "/cap-1"), { headers: authHeaders("alice") });
      expect(stillThere.status).toBe(200);
    } finally {
      server.stop();
      sse.dispose();
    }
  });

  test("SSE subscribe at saturation → 503 (not in-band 200 error)", async () => {
    const store = createInMemorySurfaceStore();
    const sse = createCanvasSseManager({
      maxSubscribersPerSurface: 1,
      maxTotalSubscribers: 100,
      keepAliveIntervalMs: 60_000,
    });
    const server = createCanvasServer({ port: 0, pathPrefix: PREFIX }, store, sse, tokenAsAgent);
    await server.start();
    try {
      await fetch(url(server, "/sat-1"), {
        method: "POST",
        headers: authHeaders("alice"),
        body: JSON.stringify({ content: "v1" }),
      });

      const c1 = new AbortController();
      const ok = await fetch(url(server, "/sat-1/events"), {
        headers: authHeaders("alice"),
        signal: c1.signal,
      });
      expect(ok.status).toBe(200);

      const c2 = new AbortController();
      const denied = await fetch(url(server, "/sat-1/events"), {
        headers: authHeaders("alice"),
        signal: c2.signal,
      });
      expect(denied.status).toBe(503);
      expect(denied.headers.get("Retry-After")).toBe("5");
      const body = (await denied.json()) as { ok: boolean };
      expect(body.ok).toBe(false);

      c1.abort();
      c2.abort();
    } finally {
      server.stop();
      sse.dispose();
    }
  });

  test("auth-503 body does not echo backend exception text (info-leak)", async () => {
    const leakyAuth: CanvasAuthenticator = async (): Promise<Result<CanvasAuthResult>> => ({
      ok: false,
      error: {
        code: "EXTERNAL",
        message: "internal/auth: postgres pool exhausted at db-prod-3.local:5432",
        retryable: true,
      },
    });
    const store = createInMemorySurfaceStore();
    const sse = createCanvasSseManager({ keepAliveIntervalMs: 60_000 });
    const server = createCanvasServer({ port: 0, pathPrefix: PREFIX }, store, sse, leakyAuth);
    await server.start();
    try {
      const res = await fetch(`http://localhost:${server.port()}${PREFIX}/x`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "v1" }),
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("Auth backend unavailable");
      expect(body.error).not.toContain("postgres");
      expect(body.error).not.toContain("db-prod");
    } finally {
      server.stop();
      sse.dispose();
    }
  });

  test("SSE recheck throws → 503 + reserved subscriber slot is released", async () => {
    // Stub store: `get()` succeeds first time (initial read), throws second
    // (post-subscribe recheck). This proves the handler unsubscribes on the
    // exceptional path so reservations don't leak.
    let getCalls = 0;
    const baseStore = createInMemorySurfaceStore();
    await baseStore.create("s1", "v1", { ownerId: "agent-a" });
    const flakyStore = {
      ...baseStore,
      get: async (id: string) => {
        getCalls += 1;
        if (getCalls >= 2) throw new Error("backend pool exhausted");
        return baseStore.get(id);
      },
    };
    const auth: CanvasAuthenticator = async () => ({ ok: true, value: { agentId: "agent-a" } });
    const sse = createCanvasSseManager({ keepAliveIntervalMs: 60_000 });
    const server = createCanvasServer({ port: 0, pathPrefix: PREFIX }, flakyStore, sse, auth);
    await server.start();
    try {
      const res = await fetch(`http://localhost:${server.port()}${PREFIX}/s1/events`, {
        headers: { Accept: "text/event-stream" },
      });
      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBe("5");
      // Drain body so the connection closes cleanly.
      await res.text();
      // Reservation must be released — manager has zero subscribers.
      expect(sse.subscriberCount("s1")).toBe(0);
      expect(sse.totalSubscribers()).toBe(0);
    } finally {
      server.stop();
      sse.dispose();
    }
  });

  test("retryable authenticator failure → 503 (not 401)", async () => {
    const flakyAuth: CanvasAuthenticator = async (): Promise<Result<CanvasAuthResult>> => ({
      ok: false,
      error: { code: "EXTERNAL", message: "auth backend timeout", retryable: true },
    });
    const store = createInMemorySurfaceStore();
    const sse = createCanvasSseManager({ keepAliveIntervalMs: 60_000 });
    const server = createCanvasServer({ port: 0, pathPrefix: PREFIX }, store, sse, flakyAuth);
    await server.start();
    try {
      const res = await fetch(`http://localhost:${server.port()}${PREFIX}/x`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "v1" }),
      });
      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBe("5");
    } finally {
      server.stop();
      sse.dispose();
    }
  });

  test("createCanvasServer rejects empty pathPrefix ('/' or '')", () => {
    const store = createInMemorySurfaceStore();
    const sse = createCanvasSseManager({ keepAliveIntervalMs: 60_000 });
    try {
      expect(() => createCanvasServer({ port: 0, pathPrefix: "/" }, store, sse)).toThrow(
        /pathPrefix cannot be/,
      );
      expect(() => createCanvasServer({ port: 0, pathPrefix: "" }, store, sse)).toThrow(
        /pathPrefix cannot be/,
      );
    } finally {
      sse.dispose();
    }
  });

  test("store backend throws on POST → 503 (not 500)", async () => {
    const auth: CanvasAuthenticator = async () => ({ ok: true, value: { agentId: "alice" } });
    const flakyStore = {
      ...createInMemorySurfaceStore(),
      create: async () => {
        throw new Error("backend down");
      },
    };
    const sse = createCanvasSseManager({ keepAliveIntervalMs: 60_000 });
    const server = createCanvasServer({ port: 0, pathPrefix: PREFIX }, flakyStore, sse, auth);
    await server.start();
    try {
      const res = await fetch(`http://localhost:${server.port()}${PREFIX}/x`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "v1" }),
      });
      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBe("5");
    } finally {
      server.stop();
      sse.dispose();
    }
  });

  test("store backend throws on GET → 503", async () => {
    const auth: CanvasAuthenticator = async () => ({ ok: true, value: { agentId: "alice" } });
    const flakyStore = {
      ...createInMemorySurfaceStore(),
      get: async () => {
        throw new Error("backend down");
      },
    };
    const sse = createCanvasSseManager({ keepAliveIntervalMs: 60_000 });
    const server = createCanvasServer({ port: 0, pathPrefix: PREFIX }, flakyStore, sse, auth);
    await server.start();
    try {
      const res = await fetch(`http://localhost:${server.port()}${PREFIX}/x`);
      expect(res.status).toBe(503);
    } finally {
      server.stop();
      sse.dispose();
    }
  });

  test("authenticator throwing → 503 (not 500/401)", async () => {
    const throwingAuth: CanvasAuthenticator = async () => {
      throw new Error("network down");
    };
    const store = createInMemorySurfaceStore();
    const sse = createCanvasSseManager({ keepAliveIntervalMs: 60_000 });
    const server = createCanvasServer({ port: 0, pathPrefix: PREFIX }, store, sse, throwingAuth);
    await server.start();
    try {
      const res = await fetch(`http://localhost:${server.port()}${PREFIX}/x`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "v1" }),
      });
      expect(res.status).toBe(503);
    } finally {
      server.stop();
      sse.dispose();
    }
  });
});
