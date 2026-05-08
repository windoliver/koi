import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AgentId, SessionId } from "@koi/core";
import type { AgentStatus, MetricPoint, SessionSummary, WsEvent } from "@koi/dashboard-types";
import type { Server } from "bun";
import { createDashboardClient, type DashboardClient } from "../client.js";

const asAgentId = (s: string): AgentId => s as AgentId;
const asSessionId = (s: string): SessionId => s as SessionId;

/**
 * Integration coverage for what unit tests cannot prove: the SDK's URL
 * construction, query-string encoding, fetch wiring, and SSE lifecycle
 * survive a real (in-process) HTTP+SSE server. Unit tests cover envelope
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
  pushTo(stream: ReadableStreamDefaultController<Uint8Array>, event: WsEvent): void;
  closeStream(stream: ReadableStreamDefaultController<Uint8Array>): void;
  closeAllStreams(): void;
}

let env: TestServer;
let client: DashboardClient;
const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
const capturedQueries: string[] = [];
const encoder = new TextEncoder();

beforeAll(() => {
  const server = Bun.serve({
    port: 0,
    fetch(req, _server): Response | undefined {
      const url = new URL(req.url);
      if (url.pathname === "/api/agents") {
        return Response.json({
          ok: true,
          value: { items: [wellFormedAgent("a1"), wellFormedAgent("a2")] },
        });
      }
      if (url.pathname.startsWith("/api/agents/")) {
        const id = decodeURIComponent(url.pathname.slice("/api/agents/".length));
        if (id === "missing") return Response.json({ ok: true });
        return Response.json({ ok: true, value: wellFormedAgent(id) });
      }
      if (url.pathname === "/api/sessions") {
        return Response.json({ ok: true, value: { items: [wellFormedSession] } });
      }
      if (url.pathname === "/api/metrics") {
        capturedQueries.push(url.search);
        return Response.json({ ok: true, value: [wellFormedMetric] });
      }
      if (url.pathname === "/api/events") {
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
        const stream = new ReadableStream<Uint8Array>({
          start(nextController) {
            controller = nextController;
            streams.add(nextController);
            nextController.enqueue(encoder.encode(": connected\n\n"));
          },
          cancel() {
            if (controller !== undefined) streams.delete(controller);
          },
        });
        return new Response(stream, {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache, no-transform",
          },
        });
      }
      if (url.pathname.startsWith("/api/traces/")) {
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(): void {
        // unused in SSE coverage
      },
      close(): void {
        // unused in SSE coverage
      },
      message(): void {
        // unused in SSE coverage
      },
    },
  });
  env = {
    server,
    url: `http://localhost:${server.port}`,
    capturedQueries,
    pushTo: (stream, event): void => {
      stream.enqueue(
        encoder.encode(
          `event: batch\ndata: ${JSON.stringify({ seq: 1, timestampMs: Date.now(), events: [event] })}\n\n`,
        ),
      );
    },
    closeStream: (stream): void => {
      try {
        stream.close();
      } finally {
        streams.delete(stream);
      }
    },
    closeAllStreams: (): void => {
      for (const stream of [...streams]) {
        env.closeStream(stream);
      }
      streams.clear();
    },
  };
  client = createDashboardClient({ baseUrl: env.url });
});

afterAll(() => {
  env.closeAllStreams();
  env.server.stop(true);
});

describe("HTTP integration", () => {
  test("listAgents reads a real envelope over real fetch", async () => {
    const r = await client.listAgents();
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.value.items.map((a) => a.agentId)).toEqual([asAgentId("a1"), asAgentId("a2")]);
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
    // Multi-name queries fan out one request per name; each request encodes
    // only `name` and `since`. `to`/`tags`/`limit` are enforced client-side
    // (server applies `limit` before ordering, so forwarding it would
    // truncate to the OLDEST N points per name).
    expect(capturedQueries.length).toBe(2);
    for (const q of capturedQueries) {
      expect(q).toContain("since=100");
      expect(q).not.toContain("limit=");
      expect(q).not.toContain("from=");
      expect(q).not.toContain("to=");
      expect(q).not.toContain("tag=");
    }
    const allQueries = capturedQueries.join("|");
    expect(allQueries).toContain("name=cpu");
    expect(allQueries).toContain("name=mem");
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

describe("SSE integration", () => {
  test("subscribe receives a server-pushed agent-status event", async () => {
    const events: WsEvent[] = [];
    const dispose = client.subscribe(["agent-status"], { onEvent: (e) => events.push(e) });
    await waitFor(() => streams.size === 1, 1000);
    const [stream] = [...streams];
    if (stream === undefined) throw new Error("no stream");
    env.pushTo(stream, { v: 1, kind: "agent-status", status: wellFormedAgent("a1") });
    await waitFor(() => events.length === 1, 1000);
    expect(events[0]?.kind).toBe("agent-status");
    dispose();
    await waitFor(() => streams.size === 0, 1000);
  });

  test("malformed frames are silently dropped (forward compat)", async () => {
    const events: WsEvent[] = [];
    const dispose = client.subscribe(["metric"], { onEvent: (e) => events.push(e) });
    await waitFor(() => streams.size === 1, 1000);
    const [stream] = [...streams];
    if (stream === undefined) throw new Error("no stream");
    stream.enqueue(encoder.encode("event: batch\ndata: not json\n\n"));
    stream.enqueue(
      encoder.encode(
        `event: batch\ndata: ${JSON.stringify({
          seq: 1,
          timestampMs: Date.now(),
          events: [
            { v: 2, kind: "metric" },
            { v: 1, kind: "metric", points: [wellFormedMetric] },
          ],
        })}\n\n`,
      ),
    );
    await waitFor(() => events.length === 1, 1000);
    expect(events).toHaveLength(1);
    dispose();
    await waitFor(() => streams.size === 0, 1000);
  });

  test("remote close fires onClose exactly once", async () => {
    let closes = 0;
    const dispose = client.subscribe(["metric"], {
      onEvent: (): void => undefined,
      onClose: (): void => {
        closes += 1;
      },
    });
    await waitFor(() => streams.size === 1, 1000);
    const [stream] = [...streams];
    if (stream === undefined) throw new Error("no stream");
    env.closeStream(stream);
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
    await waitFor(() => streams.size === 1, 1000);
    dispose();
    await waitFor(() => streams.size === 0, 1000);
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
