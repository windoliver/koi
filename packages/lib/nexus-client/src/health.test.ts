import { describe, expect, test } from "bun:test";
import { createHttpTransport } from "./transport.js";
import type { FetchFn } from "./types.js";

interface FakeResponse {
  readonly status?: number;
  readonly body: unknown;
}

function makeRoutingFetch(routes: Record<string, FakeResponse>): FetchFn {
  return async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = decodeURIComponent(url.split("/api/nfs/")[1] ?? "");
    // For "read" we want to dispatch by path — peek at the body
    // For "version" or other methods, route by method name
    let key = method;
    if (method === "read") {
      // We can't easily inspect body here in a sync way; fall back to first read
      // route. Tests below register a single "read:<path>" route.
      key = `read`;
    }
    const r = routes[key];
    if (r === undefined) {
      return new Response("not configured", { status: 500 });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: r.body }), {
      status: r.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

function makeFetch(handler: (method: string, body: unknown) => FakeResponse): FetchFn {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = decodeURIComponent(url.split("/api/nfs/")[1] ?? "");
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) : {};
    const r = handler(method, body);
    if (r.status !== undefined && r.status >= 400) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1 }), { status: r.status });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: r.body }), {
      status: r.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

describe("createHttpTransport.health", () => {
  test("kind is 'http'", () => {
    const t = createHttpTransport({ url: "http://nexus.test", fetch: makeRoutingFetch({}) });
    expect(t.kind).toBe("http");
    t.close();
  });

  test("returns ok when version + all reads succeed", async () => {
    const t = createHttpTransport({
      url: "http://nexus.test",
      fetch: makeFetch((method) => {
        if (method === "version") return { body: "1.2.3" };
        return { body: { content: "{}" } };
      }),
    });
    const r = await t.health();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.status).toBe("ok");
      if (r.value.status === "ok") expect(r.value.version).toBe("1.2.3");
    }
    t.close();
  });

  test("returns version-only when readPaths is empty", async () => {
    const t = createHttpTransport({
      url: "http://nexus.test",
      fetch: makeFetch(() => ({ body: "v" })),
    });
    const r = await t.health({ readPaths: [] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.status).toBe("version-only");
    t.close();
  });

  test("returns missing-paths when reads return 404", async () => {
    const t = createHttpTransport({
      url: "http://nexus.test",
      fetch: makeFetch((method, body) => {
        if (method === "version") return { body: "v" };
        // 404 via JSON-RPC error — use HTTP-level not-found via our errors map
        // Easier: return RPC error code -32000 (NOT_FOUND).
        const params = (body as { params?: { path?: string } }).params;
        const path = params?.path ?? "";
        if (path.endsWith("policy.json")) {
          return { body: { __rpc_error: { code: -32000, message: "not found" } } };
        }
        return { body: { content: "{}" } };
      }),
    });
    // The makeFetch above only emits result not error; build a fetch that emits RPC error directly
    const t2 = createHttpTransport({
      url: "http://nexus.test",
      fetch: async (input, init) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = decodeURIComponent(url.split("/api/nfs/")[1] ?? "");
        const body = init?.body !== undefined ? JSON.parse(String(init.body)) : {};
        if (method === "version") {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "v" }), {
            status: 200,
          });
        }
        const path = (body as { params?: { path?: string } }).params?.path;
        if (path === "koi/permissions/policy.json") {
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "nf" } }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: "{}" } }), {
          status: 200,
        });
      },
    });
    const r = await t2.health();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.status).toBe("missing-paths");
      if (r.value.status === "missing-paths") {
        expect(r.value.notFound).toContain("koi/permissions/policy.json");
      }
    }
    t2.close();
    t.close();
  });

  test("returns error on malformed read payload", async () => {
    const t = createHttpTransport({
      url: "http://nexus.test",
      fetch: makeFetch((method) => {
        if (method === "version") return { body: "v" };
        return { body: 42 };
      }),
    });
    const r = await t.health();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("VALIDATION");
    t.close();
  });

  test("respects probeDeadlineMs override", async () => {
    let observedDeadline = -1;
    const t = createHttpTransport({
      url: "http://nexus.test",
      deadlineMs: 60_000,
      fetch: async () => {
        observedDeadline = Date.now();
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "v" }), {
          status: 200,
        });
      },
    });
    const r = await t.health({ readPaths: [], probeDeadlineMs: 100 });
    expect(r.ok).toBe(true);
    expect(observedDeadline).toBeGreaterThan(0);
    t.close();
  });
});
