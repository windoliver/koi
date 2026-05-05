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
});
