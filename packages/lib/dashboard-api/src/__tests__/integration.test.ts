/**
 * Real `Bun.serve()` integration tests — spins up the handler on port 0 and
 * hits it with `fetch` so we exercise the actual HTTP framing, headers, and
 * SSE wire format, not just the in-process Request → Response path.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { agentId } from "@koi/core";
import type { AgentStatusEvent, MetricEvent } from "@koi/dashboard-types";

import { createDashboardApi } from "../handler.js";
import {
  createFixtureSource,
  type FixtureControls,
  makeAgent,
  makeMetric,
  makeSession,
} from "../test-fixtures.js";
import type { DashboardApi, DashboardDataSource } from "../types.js";

const TOKEN = "integration-token";

interface ServerHandle {
  readonly url: string;
  readonly fx: FixtureControls;
  readonly stop: () => void;
}

function startServer(overrides: Partial<DashboardDataSource> = {}): ServerHandle {
  const fx = createFixtureSource();
  fx.setAgents([
    makeAgent({ agentId: agentId("alpha"), name: "Alpha", state: "running" }),
    makeAgent({ agentId: agentId("beta"), name: "Beta", state: "terminated" }),
  ]);
  fx.setSessions([makeSession()]);
  fx.setMetrics([
    makeMetric({ name: "tokens", value: 10, timestampMs: 100 }),
    makeMetric({ name: "tokens", value: 20, timestampMs: 200 }),
  ]);

  const source: DashboardDataSource = { ...fx.source, ...overrides };
  const api: DashboardApi = createDashboardApi({
    source,
    authToken: TOKEN,
    version: "0.1.0",
    sseFlushMs: 25,
    sseBufferLimit: 4,
  });

  // Bun.serve picks a port when port: 0 is given; the returned object exposes it.
  const server = Bun.serve({ port: 0, fetch: api.fetch });
  const url = `http://localhost:${server.port}`;
  return {
    url,
    fx,
    stop: () => {
      server.stop(true);
    },
  };
}

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}` };
}

// ---------------------------------------------------------------------------
// A. Happy path
// ---------------------------------------------------------------------------

describe("happy path", () => {
  let h: ServerHandle;
  beforeAll(() => {
    h = startServer();
  });
  afterAll(() => {
    h.stop();
  });

  test("/health is open, returns version", async () => {
    const r = await fetch(`${h.url}/health`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: true; value: { version: string } };
    expect(body.value.version).toBe("0.1.0");
  });

  test("/agents lists fixtures", async () => {
    const r = await fetch(`${h.url}/agents`, { headers: authHeaders() });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { value: { items: ReadonlyArray<{ agentId: string }> } };
    expect(body.value.items.length).toBe(2);
  });

  test("/agents?state=terminated filters", async () => {
    const r = await fetch(`${h.url}/agents?state=terminated`, { headers: authHeaders() });
    const body = (await r.json()) as { value: { items: ReadonlyArray<{ agentId: string }> } };
    expect(body.value.items.length).toBe(1);
    expect(body.value.items[0]?.agentId).toBe("beta");
  });

  test("/agents/:id detail", async () => {
    const r = await fetch(`${h.url}/agents/alpha`, { headers: authHeaders() });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { value: { name: string } };
    expect(body.value.name).toBe("Alpha");
  });

  test("POST /agents/:id/terminate returns 202", async () => {
    const r = await fetch(`${h.url}/agents/alpha/terminate`, {
      method: "POST",
      headers: authHeaders(),
    });
    expect(r.status).toBe(202);
  });

  test("/metrics filtered by since", async () => {
    const r = await fetch(`${h.url}/metrics?since=150`, { headers: authHeaders() });
    const body = (await r.json()) as { value: { points: ReadonlyArray<unknown> } };
    expect(body.value.points.length).toBe(1);
  });

  test("limit clamped to max", async () => {
    const r = await fetch(`${h.url}/agents?limit=9999`, { headers: authHeaders() });
    const body = (await r.json()) as { value: { items: ReadonlyArray<unknown> } };
    expect(body.value.items.length).toBeLessThanOrEqual(200);
  });
});

// ---------------------------------------------------------------------------
// B. Auth failures
// ---------------------------------------------------------------------------

describe("auth failures", () => {
  let h: ServerHandle;
  beforeAll(() => {
    h = startServer();
  });
  afterAll(() => {
    h.stop();
  });

  test("missing Authorization → 401", async () => {
    const r = await fetch(`${h.url}/agents`);
    expect(r.status).toBe(401);
  });

  test("non-Bearer scheme → 401", async () => {
    const r = await fetch(`${h.url}/agents`, { headers: { authorization: "Basic abc" } });
    expect(r.status).toBe(401);
  });

  test("wrong token → 401", async () => {
    const r = await fetch(`${h.url}/agents`, { headers: { authorization: "Bearer wrong" } });
    expect(r.status).toBe(401);
  });

  test("/health does not require auth", async () => {
    const r = await fetch(`${h.url}/health`);
    expect(r.status).toBe(200);
  });

  test("unconfigured token → 503 fail-closed", async () => {
    const fx = createFixtureSource();
    const api = createDashboardApi({ source: fx.source, authToken: "" });
    const server = Bun.serve({ port: 0, fetch: api.fetch });
    try {
      const r = await fetch(`http://localhost:${server.port}/agents`, {
        headers: authHeaders(),
      });
      expect(r.status).toBe(503);
      const body = (await r.json()) as { ok: false; error: { code: string } };
      expect(body.error.code).toBe("UNAVAILABLE");
    } finally {
      server.stop(true);
    }
  });
});

// ---------------------------------------------------------------------------
// C. Malformed inputs
// ---------------------------------------------------------------------------

describe("malformed inputs", () => {
  let h: ServerHandle;
  beforeAll(() => {
    h = startServer();
  });
  afterAll(() => {
    h.stop();
  });

  test("malformed percent-encoded path → 404 (not 500)", async () => {
    const r = await fetch(`${h.url}/traces/%E0%A4%A`, { headers: authHeaders() });
    expect(r.status).toBe(404);
  });

  test("non-numeric since → 400 VALIDATION", async () => {
    const r = await fetch(`${h.url}/metrics?since=tomorrow`, { headers: authHeaders() });
    expect(r.status).toBe(400);
  });

  test("DELETE on /agents/:id → 405 with Allow header", async () => {
    const r = await fetch(`${h.url}/agents/alpha`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("GET");
  });

  test("GET on /agents/:id/terminate → 405", async () => {
    const r = await fetch(`${h.url}/agents/alpha/terminate`, { headers: authHeaders() });
    expect(r.status).toBe(405);
  });

  test("unknown route → 404", async () => {
    const r = await fetch(`${h.url}/bogus`, { headers: authHeaders() });
    expect(r.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// D. SSE behaviour
// ---------------------------------------------------------------------------

// Cross-runtime structural reader: Bun's local typings resolve `getReader()`
// to a `stream/web` reader (no `readMany`), CI's typings resolve it to the
// DOM lib reader (has `readMany`). Both share these two methods, so a
// minimal duck-typed shape satisfies both without `as Type` casts. Using an
// explicit `value: T | undefined` (not optional) sidesteps
// `exactOptionalPropertyTypes` rejecting compatibility with library readers.
interface StreamReader {
  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array | undefined }>;
  cancel(reason?: unknown): Promise<void>;
}

/**
 * Read from a streaming response until `until(received)` returns true or the
 * total budget elapses. A single `reader.read()` is kept in-flight across
 * tick races to avoid leaking pending reads — if every iteration started a
 * fresh `read()`, chunks would go to the first orphaned read in the queue
 * and the latest iteration would never see them.
 */
async function readUntil(
  reader: StreamReader,
  until: (received: string) => boolean,
  budgetMs: number,
): Promise<string> {
  const decoder = new TextDecoder();
  let received = "";
  const deadline = Date.now() + budgetMs;
  type ReadResult = Awaited<ReturnType<StreamReader["read"]>>;
  type TickResult = { readonly timeout: true };
  let pending: Promise<ReadResult> | undefined;
  while (Date.now() < deadline) {
    if (pending === undefined) pending = reader.read();
    const tick = new Promise<TickResult>((resolve) => {
      setTimeout(() => resolve({ timeout: true }), 50);
    });
    const result: ReadResult | TickResult = await Promise.race([pending, tick]);
    if ("timeout" in result) {
      if (until(received)) break;
      continue;
    }
    pending = undefined;
    if (result.done) break;
    if (result.value !== undefined) {
      received += decoder.decode(result.value as Uint8Array);
    }
    if (until(received)) break;
  }
  return received;
}

/** Tear down a streaming response: stop server first (force-closes sockets),
 *  then cancel the reader. Awaiting cancel before stop hangs because the
 *  server side of the TransformStream stays open until the socket dies. */
function teardownStream(h: ServerHandle, reader: StreamReader | undefined): void {
  h.stop();
  reader?.cancel().catch(() => {
    // Expected — the underlying socket is already closed.
  });
}

describe("SSE", () => {
  test("emits content-type text/event-stream", async () => {
    const h = startServer();
    let reader: StreamReader | undefined;
    try {
      const r = await fetch(`${h.url}/events`, { headers: authHeaders() });
      expect(r.headers.get("content-type")).toBe("text/event-stream");
      reader = r.body?.getReader();
    } finally {
      teardownStream(h, reader);
    }
  });

  test("delivers an emitted event to the client", async () => {
    const h = startServer();
    let reader: StreamReader | undefined;
    try {
      const r = await fetch(`${h.url}/events`, { headers: authHeaders() });
      reader = r.body?.getReader();
      if (reader === undefined) throw new Error("no body");
      const event: AgentStatusEvent = {
        v: 1,
        kind: "agent-status",
        status: makeAgent({ agentId: agentId("ag-x") }),
      };
      h.fx.emit(event);
      const received = await readUntil(reader, (s) => s.includes("event: batch"), 2000);
      expect(received).toContain("event: batch");
      expect(received).toContain('"kind":"agent-status"');
    } finally {
      teardownStream(h, reader);
    }
  });

  test("topic filter excludes other event kinds", async () => {
    const h = startServer();
    let reader: StreamReader | undefined;
    try {
      const r = await fetch(`${h.url}/events?topics=metric`, { headers: authHeaders() });
      reader = r.body?.getReader();
      if (reader === undefined) throw new Error("no body");

      h.fx.emit({
        v: 1,
        kind: "agent-status",
        status: makeAgent({ agentId: agentId("x") }),
      });
      const m: MetricEvent = {
        v: 1,
        kind: "metric",
        points: [makeMetric({ name: "tokens.in", value: 1 })],
      };
      h.fx.emit(m);

      const received = await readUntil(reader, (s) => s.includes('"kind":"metric"'), 2000);
      expect(received).toContain('"kind":"metric"');
      expect(received).not.toContain('"kind":"agent-status"');
    } finally {
      teardownStream(h, reader);
    }
  });

  test("buffer-overflow drops oldest events", async () => {
    const h = startServer();
    let reader: StreamReader | undefined;
    try {
      const r = await fetch(`${h.url}/events`, { headers: authHeaders() });
      reader = r.body?.getReader();
      if (reader === undefined) throw new Error("no body");

      // Buffer limit is 4 (set in startServer); emit 6 before flush.
      for (let i = 0; i < 6; i += 1) {
        h.fx.emit({
          v: 1,
          kind: "agent-status",
          status: makeAgent({ agentId: agentId(`ag-${i}`) }),
        });
      }

      const received = await readUntil(reader, (s) => s.includes("event: batch"), 2000);
      const match = received.match(/"events":(\[[\s\S]*?\])\}/);
      expect(match).not.toBeNull();
      if (match !== null && match[1] !== undefined) {
        const arr = JSON.parse(match[1]) as readonly unknown[];
        expect(arr.length).toBeLessThanOrEqual(4);
      }
    } finally {
      teardownStream(h, reader);
    }
  });
});

// ---------------------------------------------------------------------------
// E. Data-source classification (Result contract)
// ---------------------------------------------------------------------------

describe("data-source error classification", () => {
  test("RATE_LIMIT → 429 with retryAfterMs", async () => {
    const h = startServer({
      listAgents: () => ({
        ok: false,
        error: {
          code: "RATE_LIMIT",
          message: "slow",
          retryable: true,
          retryAfterMs: 1500,
        },
      }),
    });
    try {
      const r = await fetch(`${h.url}/agents`, { headers: authHeaders() });
      expect(r.status).toBe(429);
      const body = (await r.json()) as {
        ok: false;
        error: { code: string; retryable: boolean; retryAfterMs: number };
      };
      expect(body.error.code).toBe("RATE_LIMIT");
      expect(body.error.retryable).toBe(true);
      expect(body.error.retryAfterMs).toBe(1500);
    } finally {
      h.stop();
    }
  });

  test("UNAVAILABLE → 503", async () => {
    const h = startServer({
      listSessions: () => ({
        ok: false,
        error: { code: "UNAVAILABLE", message: "down", retryable: false },
      }),
    });
    try {
      const r = await fetch(`${h.url}/sessions`, { headers: authHeaders() });
      expect(r.status).toBe(503);
    } finally {
      h.stop();
    }
  });

  test("TIMEOUT → 504", async () => {
    const h = startServer({
      listTraces: () => ({
        ok: false,
        error: { code: "TIMEOUT", message: "slow query", retryable: true },
      }),
    });
    try {
      const r = await fetch(`${h.url}/traces`, { headers: authHeaders() });
      expect(r.status).toBe(504);
    } finally {
      h.stop();
    }
  });

  test("PERMISSION → 403", async () => {
    const h = startServer({
      getAgent: () => ({
        ok: false,
        error: { code: "PERMISSION", message: "no", retryable: false },
      }),
    });
    try {
      const r = await fetch(`${h.url}/agents/alpha`, { headers: authHeaders() });
      expect(r.status).toBe(403);
    } finally {
      h.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// F. Cause / log leakage
// ---------------------------------------------------------------------------

describe("error sanitization", () => {
  test("KoiError.cause is dropped from response body", async () => {
    const h = startServer({
      listAgents: () => ({
        ok: false,
        error: {
          code: "EXTERNAL",
          message: "upstream",
          retryable: false,
          cause: { secretToken: "deadbeef-DO-NOT-LEAK" },
        },
      }),
    });
    try {
      const r = await fetch(`${h.url}/agents`, { headers: authHeaders() });
      const text = await r.text();
      expect(text).not.toContain("deadbeef");
      expect(text).not.toContain("cause");
    } finally {
      h.stop();
    }
  });

  test("thrown Error: response stays opaque, secret never reaches wire", async () => {
    const h = startServer({
      listAgents: () => {
        const err = new Error("storage offline") as Error & { secretKey?: string };
        err.secretKey = "supersecret-DO-NOT-LEAK";
        throw err;
      },
    });
    try {
      const r = await fetch(`${h.url}/agents`, { headers: authHeaders() });
      expect(r.status).toBe(500);
      const text = await r.text();
      expect(text).not.toContain("supersecret");
      expect(text).not.toContain("storage offline");
      const body = JSON.parse(text);
      expect(body.error.code).toBe("INTERNAL");
    } finally {
      h.stop();
    }
  });
});
