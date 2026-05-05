import { beforeEach, describe, expect, test } from "bun:test";
import { agentId } from "@koi/core";

import { createDashboardApi } from "./handler.js";
import {
  createFixtureSource,
  type FixtureControls,
  makeAgent,
  makeMetric,
  makeSession,
  makeTrace,
} from "./test-fixtures.js";
import type { ApiResult, DashboardApi } from "./types.js";

const TOKEN = "test-token";

function authedReq(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${TOKEN}`);
  return new Request(`http://localhost${path}`, { ...init, headers });
}

async function readJson<T>(r: Response): Promise<ApiResult<T>> {
  return (await r.json()) as ApiResult<T>;
}

let fx: FixtureControls;
let api: DashboardApi;

beforeEach(() => {
  fx = createFixtureSource();
  api = createDashboardApi({ source: fx.source, authToken: TOKEN, version: "0.1.0" });
});

describe("auth", () => {
  test("rejects missing token with 401", async () => {
    const r = await api.fetch(new Request("http://localhost/agents"));
    expect(r.status).toBe(401);
    const body = await readJson(r);
    expect(body.ok).toBe(false);
    if (!body.ok) expect(body.error.code).toBe("AUTH_REQUIRED");
  });

  test("rejects invalid token", async () => {
    const r = await api.fetch(
      new Request("http://localhost/agents", {
        headers: { authorization: "Bearer wrong" },
      }),
    );
    expect(r.status).toBe(401);
  });

  test("returns 503 when auth token unconfigured", async () => {
    const noAuth = createDashboardApi({ source: fx.source, authToken: "" });
    const r = await noAuth.fetch(authedReq("/agents"));
    expect(r.status).toBe(503);
    const body = await readJson(r);
    if (!body.ok) expect(body.error.code).toBe("UNAVAILABLE");
  });

  test("/health is unauthenticated", async () => {
    const r = await api.fetch(new Request("http://localhost/health"));
    expect(r.status).toBe(200);
    const body = await readJson<{ ok: true; version: string }>(r);
    expect(body.ok).toBe(true);
    if (body.ok) expect(body.value.version).toBe("0.1.0");
  });
});

describe("GET /agents", () => {
  test("returns paginated list", async () => {
    fx.setAgents([makeAgent({ agentId: agentId("a") }), makeAgent({ agentId: agentId("b") })]);
    const r = await api.fetch(authedReq("/agents"));
    expect(r.status).toBe(200);
    const body = await readJson<{ items: ReadonlyArray<{ agentId: string }> }>(r);
    expect(body.ok).toBe(true);
    if (body.ok) expect(body.value.items.length).toBe(2);
  });

  test("filters by state", async () => {
    fx.setAgents([
      makeAgent({ agentId: agentId("a"), state: "running" }),
      makeAgent({ agentId: agentId("b"), state: "terminated" }),
    ]);
    const r = await api.fetch(authedReq("/agents?state=running"));
    const body = await readJson<{ items: ReadonlyArray<{ agentId: string }> }>(r);
    if (body.ok) {
      expect(body.value.items.length).toBe(1);
      expect(body.value.items[0]?.agentId).toBe("a");
    }
  });

  test("clamps oversized limit", async () => {
    const many = Array.from({ length: 250 }, (_, i) => makeAgent({ agentId: agentId(`a${i}`) }));
    fx.setAgents(many);
    const r = await api.fetch(authedReq("/agents?limit=9999"));
    const body = await readJson<{ items: readonly unknown[] }>(r);
    if (body.ok) expect(body.value.items.length).toBe(200);
  });
});

describe("GET /agents/:id", () => {
  test("returns agent when found", async () => {
    fx.setAgents([makeAgent({ agentId: agentId("a"), name: "alpha" })]);
    const r = await api.fetch(authedReq("/agents/a"));
    expect(r.status).toBe(200);
    const body = await readJson<{ name: string }>(r);
    if (body.ok) expect(body.value.name).toBe("alpha");
  });

  test("returns 404 for unknown agent", async () => {
    const r = await api.fetch(authedReq("/agents/missing"));
    expect(r.status).toBe(404);
    const body = await readJson(r);
    if (!body.ok) expect(body.error.code).toBe("NOT_FOUND");
  });

  test("rejects unsupported methods", async () => {
    const r = await api.fetch(authedReq("/agents/a", { method: "DELETE" }));
    expect(r.status).toBe(405);
  });
});

describe("POST /agents/:id/terminate", () => {
  test("returns 202 when terminate succeeds", async () => {
    fx.setAgents([makeAgent({ agentId: agentId("a") })]);
    const r = await api.fetch(authedReq("/agents/a/terminate", { method: "POST" }));
    expect(r.status).toBe(202);
    expect(fx.terminatedAgents.has("a")).toBe(true);
  });

  test("returns 404 when agent missing", async () => {
    const r = await api.fetch(authedReq("/agents/x/terminate", { method: "POST" }));
    expect(r.status).toBe(404);
  });

  test("rejects GET on terminate", async () => {
    fx.setAgents([makeAgent({ agentId: agentId("a") })]);
    const r = await api.fetch(authedReq("/agents/a/terminate"));
    expect(r.status).toBe(405);
  });
});

describe("GET /sessions", () => {
  test("filters by agentId + status", async () => {
    fx.setSessions([
      makeSession({ agentId: agentId("a"), status: "active" }),
      makeSession({ agentId: agentId("b"), status: "completed" }),
    ]);
    const r = await api.fetch(authedReq("/sessions?agentId=a"));
    const body = await readJson<{ items: readonly unknown[] }>(r);
    if (body.ok) expect(body.value.items.length).toBe(1);
  });
});

describe("GET /metrics", () => {
  test("returns points filtered by since", async () => {
    fx.setMetrics([
      makeMetric({ name: "x", timestampMs: 100 }),
      makeMetric({ name: "x", timestampMs: 200 }),
    ]);
    const r = await api.fetch(authedReq("/metrics?since=150"));
    expect(r.status).toBe(200);
    const body = await readJson<{ points: readonly unknown[] }>(r);
    if (body.ok) expect(body.value.points.length).toBe(1);
  });

  test("returns 400 for non-numeric since", async () => {
    const r = await api.fetch(authedReq("/metrics?since=tomorrow"));
    expect(r.status).toBe(400);
  });
});

describe("GET /traces", () => {
  test("returns trace by id", async () => {
    fx.setTraces([makeTrace({ turnId: "turn-7" })]);
    const r = await api.fetch(authedReq("/traces/turn-7"));
    expect(r.status).toBe(200);
    const body = await readJson<{ turnId: string }>(r);
    if (body.ok) expect(body.value.turnId).toBe("turn-7");
  });

  test("returns 404 for unknown turnId", async () => {
    const r = await api.fetch(authedReq("/traces/nope"));
    expect(r.status).toBe(404);
  });

  test("filters by sinceMs", async () => {
    fx.setTraces([
      makeTrace({ turnId: "old", startedAtMs: 100 }),
      makeTrace({ turnId: "new", startedAtMs: 1000 }),
    ]);
    const r = await api.fetch(authedReq("/traces?since=500"));
    const body = await readJson<{ items: ReadonlyArray<{ turnId: string }> }>(r);
    if (body.ok) {
      expect(body.value.items.length).toBe(1);
      expect(body.value.items[0]?.turnId).toBe("new");
    }
  });
});

describe("unknown route", () => {
  test("returns 404 with NOT_FOUND code", async () => {
    const r = await api.fetch(authedReq("/bogus"));
    expect(r.status).toBe(404);
    const body = await readJson(r);
    if (!body.ok) expect(body.error.code).toBe("NOT_FOUND");
  });

  test("malformed percent-encoded path returns 404 not 500", async () => {
    const r = await api.fetch(authedReq("/traces/%E0%A4%A"));
    expect(r.status).toBe(404);
  });
});

describe("cursor passthrough", () => {
  test("opaque cursor is passed to data source verbatim", async () => {
    let captured: string | undefined;
    const passthrough = createDashboardApi({
      source: {
        ...fx.source,
        listAgents: (q) => {
          captured = q.cursor;
          return { ok: true, value: { items: [] } };
        },
      },
      authToken: TOKEN,
    });
    await passthrough.fetch(authedReq("/agents?cursor=anything-the-datasource-emitted"));
    expect(captured).toBe("anything-the-datasource-emitted");
  });
});

describe("data source failures", () => {
  test("converts thrown datasource error into 500 with INTERNAL code", async () => {
    const failing = createDashboardApi({
      source: {
        ...fx.source,
        listAgents: () => {
          throw new Error("storage offline");
        },
      },
      authToken: TOKEN,
    });
    const r = await failing.fetch(authedReq("/agents"));
    expect(r.status).toBe(500);
    const body = await readJson(r);
    if (!body.ok) expect(body.error.code).toBe("INTERNAL");
  });

  test("converts rejected datasource promise into 500", async () => {
    const failing = createDashboardApi({
      source: {
        ...fx.source,
        getAgent: () => Promise.reject(new Error("db gone")),
      },
      authToken: TOKEN,
    });
    const r = await failing.fetch(authedReq("/agents/x"));
    expect(r.status).toBe(500);
  });

  test("handles non-serializable thrown values without crashing", async () => {
    // Build a value that JSON.stringify cannot serialize.
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const failing = createDashboardApi({
      source: {
        ...fx.source,
        listAgents: () => {
          const err: Error & { extra?: unknown } = new Error("boom");
          err.extra = circular;
          throw err;
        },
      },
      authToken: TOKEN,
    });
    const r = await failing.fetch(authedReq("/agents"));
    expect(r.status).toBe(500);
    // Body must still parse — sanitization stripped the unsafe cause.
    const body = await readJson(r);
    expect(body.ok).toBe(false);
    if (!body.ok) expect(body.error.code).toBe("INTERNAL");
  });

  test("hostile thrown value with inspection trap still yields 500", async () => {
    // A Proxy whose `get` always throws — touching any property to log it
    // would re-throw. The catch-all must remain side-effect-safe.
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("inspection trap");
        },
      },
    );
    const failing = createDashboardApi({
      source: {
        ...fx.source,
        listAgents: () => {
          throw hostile;
        },
      },
      authToken: TOKEN,
    });
    const r = await failing.fetch(authedReq("/agents"));
    expect(r.status).toBe(500);
    const body = await readJson(r);
    if (!body.ok) expect(body.error.code).toBe("INTERNAL");
  });

  test("logs request method, path, and Error class on internal failure", async () => {
    const captured: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      captured.push(args);
    };
    try {
      const failing = createDashboardApi({
        source: {
          ...fx.source,
          listAgents: () => {
            throw new TypeError("boom");
          },
        },
        authToken: TOKEN,
      });
      await failing.fetch(authedReq("/agents?limit=1"));
    } finally {
      console.error = originalError;
    }
    expect(captured.length).toBeGreaterThan(0);
    const flat = captured.flat().join(" ");
    expect(flat).toContain("method=GET");
    expect(flat).toContain("path=/agents");
    expect(flat).toContain("kind=TypeError");
    // But the raw error message must not leak through.
    expect(flat).not.toContain("boom");
  });

  test("structured Result error preserves UNAVAILABLE → 503", async () => {
    const failing = createDashboardApi({
      source: {
        ...fx.source,
        listAgents: () => ({
          ok: false,
          error: {
            code: "UNAVAILABLE",
            message: "backend down",
            retryable: false,
          },
        }),
      },
      authToken: TOKEN,
    });
    const r = await failing.fetch(authedReq("/agents"));
    expect(r.status).toBe(503);
    const body = await readJson<never>(r);
    expect(body.ok).toBe(false);
    if (!body.ok) {
      expect(body.error.code).toBe("UNAVAILABLE");
      expect(body.error.retryable).toBe(false);
    }
  });

  test("structured Result error preserves RATE_LIMIT → 429 with retryAfterMs", async () => {
    const failing = createDashboardApi({
      source: {
        ...fx.source,
        listSessions: () => ({
          ok: false,
          error: {
            code: "RATE_LIMIT",
            message: "slow down",
            retryable: true,
            retryAfterMs: 2000,
          },
        }),
      },
      authToken: TOKEN,
    });
    const r = await failing.fetch(authedReq("/sessions"));
    expect(r.status).toBe(429);
    const body = await readJson<never>(r);
    if (!body.ok) {
      expect(body.error.code).toBe("RATE_LIMIT");
      expect(body.error.retryable).toBe(true);
      expect(body.error.retryAfterMs).toBe(2000);
    }
  });

  test("structured Result error preserves TIMEOUT → 504", async () => {
    const failing = createDashboardApi({
      source: {
        ...fx.source,
        listTraces: () => ({
          ok: false,
          error: { code: "TIMEOUT", message: "slow query", retryable: true },
        }),
      },
      authToken: TOKEN,
    });
    const r = await failing.fetch(authedReq("/traces"));
    expect(r.status).toBe(504);
  });

  test("KoiError.cause is NEVER forwarded to the client", async () => {
    const failing = createDashboardApi({
      source: {
        ...fx.source,
        listAgents: () => ({
          ok: false,
          error: {
            code: "EXTERNAL",
            message: "upstream blew up",
            retryable: false,
            cause: { secretToken: "deadbeef-DO-NOT-LEAK" },
          },
        }),
      },
      authToken: TOKEN,
    });
    const r = await failing.fetch(authedReq("/agents"));
    const text = await r.text();
    expect(text).not.toContain("deadbeef");
    expect(text).not.toContain("cause");
    const body = JSON.parse(text);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("EXTERNAL");
  });

  test("structured Result error preserves PERMISSION → 403 with sanitized context", async () => {
    const failing = createDashboardApi({
      source: {
        ...fx.source,
        getAgent: () => ({
          ok: false,
          error: {
            code: "PERMISSION",
            message: "agent restricted",
            retryable: false,
            context: { resourceId: "a-1" },
          },
        }),
      },
      authToken: TOKEN,
    });
    const r = await failing.fetch(authedReq("/agents/a-1"));
    expect(r.status).toBe(403);
  });

  test("all datasource throws (even structured ones) collapse to 500 INTERNAL", async () => {
    // Even a thrown value with rich error metadata must NOT be propagated to
    // the client as a real 4xx — datasource adapters live outside this package
    // and may include sensitive identifiers in error messages/context. The
    // contract is to return `T | undefined` for expected failures.
    const failing = createDashboardApi({
      source: {
        ...fx.source,
        listAgents: () => {
          throw {
            code: "PERMISSION",
            message: "tenant 42 missing ACL row — internal detail",
            retryable: false,
            context: { tenantId: 42, secretKey: "deadbeef" },
          };
        },
      },
      authToken: TOKEN,
    });
    const r = await failing.fetch(authedReq("/agents"));
    expect(r.status).toBe(500);
    const text = await r.text();
    expect(text).not.toContain("tenant 42");
    expect(text).not.toContain("deadbeef");
    const body = JSON.parse(text);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("INTERNAL");
  });

  test("sensitive cause fields are not exposed to the client", async () => {
    const failing = createDashboardApi({
      source: {
        ...fx.source,
        listAgents: () => {
          const err: Error & { secretToken?: string } = new Error("kaboom");
          err.secretToken = "supersecret";
          throw err;
        },
      },
      authToken: TOKEN,
    });
    const r = await failing.fetch(authedReq("/agents"));
    const text = await r.text();
    expect(text).not.toContain("supersecret");
  });
});
