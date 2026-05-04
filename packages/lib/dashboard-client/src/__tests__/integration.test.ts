import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AgentId, SessionId } from "@koi/core";
import type { AgentStatus, MetricPoint, SessionSummary, WsEvent } from "@koi/dashboard-types";
import type { Server, ServerWebSocket } from "bun";
import { createDashboardClient, type DashboardClient } from "../client.js";

const asAgentId = (s: string): AgentId => s as AgentId;
const asSessionId = (s: string): SessionId => s as SessionId;

/**
 * Integration coverage for what unit tests cannot prove: the SDK's URL
 * construction, query-string encoding, fetch wiring, and WebSocket lifecycle
 * survive a real (in-process) HTTP+WS server. Unit tests cover envelope
 * shape, retry classification, and guard semantics.
 */

const wellFormedAgent = (id: string): AgentStatus =>
  ({
    agentId: asAgentId(id),
    name: id,
    state: "running",
    agentType: "copilot",
    channels: [],
    turns: 0,
    tokenCount: 0,
    startedAt: 1,
    lastActivityAt: 1,
    childCount: 0,
  }) as const;

const wellFormedSession: SessionSummary = {
  sessionId: asSessionId("s1"),
  agentId: asAgentId("a1"),
  status: "active",
  turns: 1,
  inputTokens: 10,
  outputTokens: 5,
  costUsd: 0.001,
  startedAt: 1,
};

const wellFormedMetric: MetricPoint = { name: "cpu", value: 1, timestampMs: 1 };

interface TestServer {
  readonly server: Server<unknown>;
  readonly url: string;
  readonly capturedQueries: string[];
  pushTo(ws: ServerWebSocket<unknown>, event: WsEvent): void;
  closeAllSockets(): void;
}

let env: TestServer;
let client: DashboardClient;
const sockets = new Set<ServerWebSocket<unknown>>();
const capturedQueries: string[] = [];

beforeAll(() => {
  const server = Bun.serve({
    port: 0,
    fetch(req, srv): Response | undefined {
      const url = new URL(req.url);
      if (url.pathname === "/api/ws") {
        if (srv.upgrade(req)) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/api/agents") {
        return Response.json({ ok: true, value: [wellFormedAgent("a1"), wellFormedAgent("a2")] });
      }
      if (url.pathname.startsWith("/api/agents/")) {
        const id = decodeURIComponent(url.pathname.slice("/api/agents/".length));
        if (id === "missing") return Response.json({ ok: true });
        return Response.json({ ok: true, value: wellFormedAgent(id) });
      }
      if (url.pathname === "/api/sessions") {
        return Response.json({ ok: true, value: [wellFormedSession] });
      }
      if (url.pathname === "/api/metrics") {
        capturedQueries.push(url.search);
        return Response.json({ ok: true, value: [wellFormedMetric] });
      }
      if (url.pathname.startsWith("/api/traces/")) {
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws): void {
        sockets.add(ws);
      },
      close(ws): void {
        sockets.delete(ws);
      },
      message(_ws, _msg): void {
        // Server simply records subscribes; per-test pushes drive event delivery.
      },
    },
  });
  env = {
    server,
    url: `http://localhost:${server.port}`,
    capturedQueries,
    pushTo: (ws, event): void => {
      ws.send(JSON.stringify(event));
    },
    closeAllSockets: (): void => {
      for (const ws of sockets) ws.close();
    },
  };
  client = createDashboardClient({ baseUrl: env.url });
});

afterAll(() => {
  env.server.stop(true);
});

describe("HTTP integration", () => {
  test("listAgents reads a real envelope over real fetch", async () => {
    const r = await client.listAgents();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.map((a) => a.agentId)).toEqual([asAgentId("a1"), asAgentId("a2")]);
  });

  test("getAgent encodes path segments (no double-encoding)", async () => {
    const r = await client.getAgent(asAgentId("a/b c"));
    expect(r.ok).toBe(true);
    if (r.ok && r.value) expect(r.value.agentId).toBe(asAgentId("a/b c"));
  });

  test("getAgent decodes ok:true with no value as undefined", async () => {
    const r = await client.getAgent(asAgentId("missing"));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeUndefined();
  });

  test("getMetrics encodes query string in stable, server-readable form", async () => {
    capturedQueries.length = 0;
    const r = await client.getMetrics({
      names: ["cpu", "mem"],
      fromMs: 100,
      toMs: 200,
      limit: 50,
      tags: { env: "prod", region: "us" },
    });
    expect(r.ok).toBe(true);
    expect(capturedQueries.length).toBe(1);
    const [q = ""] = capturedQueries;
    expect(q).toContain("name=cpu");
    expect(q).toContain("name=mem");
    expect(q).toContain("from=100");
    expect(q).toContain("to=200");
    expect(q).toContain("limit=50");
    expect(q).toContain("tag=env%3Dprod");
    expect(q).toContain("tag=region%3Dus");
  });

  test("getTrace returns undefined for ok:true with no value (optional payload)", async () => {
    const r = await client.getTrace("t1");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeUndefined();
  });

  test("trailing slash in baseUrl does not produce // in the request path", async () => {
    const slashed = createDashboardClient({ baseUrl: `${env.url}/` });
    const r = await slashed.listAgents();
    expect(r.ok).toBe(true);
  });
});

describe("WebSocket integration", () => {
  test("subscribe receives a server-pushed agent-status event", async () => {
    const events: WsEvent[] = [];
    const dispose = client.subscribe(["agent-status"], { onEvent: (e) => events.push(e) });
    // Wait until our server registered the open socket, then push a frame.
    await waitFor(() => sockets.size === 1, 1000);
    const [ws] = [...sockets];
    if (ws === undefined) throw new Error("no socket");
    env.pushTo(ws, { v: 1, kind: "agent-status", status: wellFormedAgent("a1") });
    await waitFor(() => events.length === 1, 1000);
    expect(events[0]?.kind).toBe("agent-status");
    dispose();
    await waitFor(() => sockets.size === 0, 1000);
  });

  test("malformed frames are silently dropped (forward compat)", async () => {
    const events: WsEvent[] = [];
    const dispose = client.subscribe(["metric"], { onEvent: (e) => events.push(e) });
    await waitFor(() => sockets.size === 1, 1000);
    const [ws] = [...sockets];
    if (ws === undefined) throw new Error("no socket");
    ws.send("not json");
    ws.send(JSON.stringify({ v: 2, kind: "metric" })); // wrong protocol version
    ws.send(JSON.stringify({ v: 1, kind: "metric", points: [wellFormedMetric] }));
    await waitFor(() => events.length === 1, 1000);
    expect(events).toHaveLength(1);
    dispose();
    await waitFor(() => sockets.size === 0, 1000);
  });

  test("remote close fires onClose exactly once", async () => {
    let closes = 0;
    const dispose = client.subscribe(["metric"], {
      onEvent: (): void => undefined,
      onClose: (): void => {
        closes += 1;
      },
    });
    await waitFor(() => sockets.size === 1, 1000);
    const [ws] = [...sockets];
    if (ws === undefined) throw new Error("no socket");
    ws.close();
    await waitFor(() => closes === 1, 1000);
    expect(closes).toBe(1);
    dispose();
  });

  test("caller-initiated dispose suppresses onClose", async () => {
    let closes = 0;
    const dispose = client.subscribe(["metric"], {
      onEvent: (): void => undefined,
      onClose: (): void => {
        closes += 1;
      },
    });
    await waitFor(() => sockets.size === 1, 1000);
    dispose();
    await waitFor(() => sockets.size === 0, 1000);
    // Give the event loop a couple of ticks to surface any spurious close.
    await new Promise((r) => setTimeout(r, 20));
    expect(closes).toBe(0);
  });
});

describe("HTTP failure modes (real network)", () => {
  test("connection refused decodes as retryable EXTERNAL", async () => {
    const dead = createDashboardClient({ baseUrl: "http://127.0.0.1:1" });
    const r = await dead.listAgents();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("EXTERNAL");
      expect(r.error.retryable).toBe(true);
    }
  });

  test("AbortSignal cancellation returns non-retryable EXTERNAL", async () => {
    const ac = new AbortController();
    const fetchImpl = (input: string, init?: RequestInit): Promise<Response> =>
      fetch(input, { ...init, signal: ac.signal });
    const c = createDashboardClient({ baseUrl: env.url, fetch: fetchImpl });
    ac.abort();
    const r = await c.listAgents();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("EXTERNAL");
      expect(r.error.retryable).toBe(false);
    }
  });
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
