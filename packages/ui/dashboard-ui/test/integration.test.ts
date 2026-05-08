import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { agentId, sessionId } from "@koi/core";
import { createDashboardClient, type DashboardClient } from "@koi/dashboard-client";
import type {
  AgentStatus,
  MetricPoint,
  SessionSummary,
  TraceView,
  WsEvent,
} from "@koi/dashboard-types";
import {
  fetchSessionMetrics,
  loadDashboardSnapshot,
  type DashboardClient as UiDashboardClient,
} from "../src/app.js";
import {
  applyDashboardEvent,
  createDashboardViewModel,
  type DashboardClientMetricPoint,
  type DashboardClientSessionSummary,
} from "../src/lib/state.js";
import { type FixtureServer, startFixtureServer } from "./fixture-server.js";

let server: FixtureServer;
let client: DashboardClient;
let uiClient: UiDashboardClient;

beforeAll(async () => {
  server = await startFixtureServer();
  client = createDashboardClient({
    baseUrl: server.url,
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${server.authToken}`);
      return fetch(input, { ...init, headers });
    },
  });
  // The local UI DashboardClient interface is structurally compatible with the
  // SDK client (different brand types but identical wire shape). Cast at the
  // boundary so tests can drive loadDashboardSnapshot/fetchSessionMetrics.
  uiClient = client as unknown as UiDashboardClient;
});

afterAll(async () => {
  await server.close();
});

function makeAgent(id: string, overrides: Partial<AgentStatus> = {}): AgentStatus {
  return {
    agentId: agentId(id),
    name: id,
    state: "running",
    agentType: "copilot",
    channels: [],
    turns: 0,
    tokenCount: 0,
    startedAt: 0,
    lastActivityAt: 0,
    childCount: 0,
    ...overrides,
  };
}

function makeSession(
  id: string,
  agent: string,
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    sessionId: sessionId(id),
    agentId: agentId(agent),
    status: "active",
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    startedAt: 0,
    ...overrides,
  };
}

function makeTrace(turnId: string, agent: string, startedAtMs: number): TraceView {
  return {
    turnId,
    agentId: agentId(agent),
    turnIndex: 0,
    startedAtMs,
    totalDurationMs: 100,
    root: {
      spanId: "root",
      name: "root",
      category: "model",
      startedAtMs,
      durationMs: 100,
      children: [
        {
          spanId: `${turnId}-child`,
          name: "model.invoke",
          category: "model",
          startedAtMs,
          durationMs: 100,
          children: [],
        },
      ],
    },
  };
}

describe("dashboard-ui ↔ dashboard-api integration", () => {
  test("auth: requests without bearer token return 401", async () => {
    server.setAgents([makeAgent("a1")]);
    const unauth = createDashboardClient({ baseUrl: server.url });
    const result = await unauth.listAgents();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("AUTH_REQUIRED");
  });

  test("cold load with empty fleet renders no agents and no error", async () => {
    server.setAgents([]);
    server.setSessions([]);
    const snapshot = await loadDashboardSnapshot(uiClient, { nowMs: 1_000 });
    const state = createDashboardViewModel(snapshot);
    expect(state.agents.length).toBe(0);
    expect(state.errorMessage).toBeNull();
  });

  test("snapshot pagination: drains nextCursor across multiple pages", async () => {
    const many: AgentStatus[] = [];
    for (let i = 0; i < 60; i += 1) many.push(makeAgent(`agent-${String(i).padStart(3, "0")}`));
    server.setAgents(many);
    server.setSessions([]);
    const snapshot = await loadDashboardSnapshot(uiClient, { nowMs: 1_000 });
    expect(snapshot.agents.length).toBe(60);
    expect(snapshot.agents[0]?.id).toBe("agent-000");
    expect(snapshot.agents[59]?.id).toBe("agent-059");
  });

  test("snapshot failure: throws and surfaces the server error", async () => {
    server.setAgents([makeAgent("a1")]);
    server.setSessions([]);
    server.failNext("listAgents");
    let thrown: Error | null = null;
    try {
      await loadDashboardSnapshot(uiClient, { nowMs: 1_000 });
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown?.message).toContain("Unable to load agents");
    server.clearFailures();
  });

  test("session metric fetch: filters by sessionId tag and time range", async () => {
    const nowMs = Date.parse("2026-05-07T22:15:00.000Z");
    server.setAgents([makeAgent("a1")]);
    server.setSessions([makeSession("s-target", "a1"), makeSession("s-other", "a1")]);
    const tagsTarget = { sessionId: "s-target" } as const;
    const tagsOther = { sessionId: "s-other" } as const;
    const tooOld = nowMs - 60 * 60_000; // 1h ago — outside 30m window
    const metrics: MetricPoint[] = [
      { name: "latency_ms", value: 100, timestampMs: nowMs - 5_000, tags: tagsTarget },
      { name: "latency_ms", value: 999, timestampMs: nowMs - 5_000, tags: tagsOther },
      { name: "latency_ms", value: 50, timestampMs: tooOld, tags: tagsTarget },
      { name: "token_usage", value: 1234, timestampMs: nowMs - 1_000, tags: tagsTarget },
    ];
    server.setMetrics(metrics);
    const points = await fetchSessionMetrics(uiClient, "s-target", nowMs);
    expect(points).not.toBeNull();
    if (!points) return;
    // Only s-target points within the window.
    expect(points.every((p) => p.tags?.sessionId === "s-target")).toBe(true);
    expect(points.every((p) => p.timestampMs >= nowMs - 30 * 60_000)).toBe(true);
    expect(points.length).toBe(2);
  });

  test("partial metric failure: returns null so UI can show degraded state", async () => {
    server.setAgents([makeAgent("a1")]);
    server.setSessions([makeSession("s1", "a1")]);
    server.setMetrics([
      {
        name: "latency_ms",
        value: 1,
        timestampMs: 1,
        tags: { sessionId: "s1" },
      },
    ]);
    server.failMetricsForName("tool_calls");
    const points = await fetchSessionMetrics(uiClient, "s1", 100_000);
    expect(points).toBeNull();
    server.clearFailures();
  });

  test("getMetrics fan-out: enforces global limit newest-first", async () => {
    const points: MetricPoint[] = [];
    for (let i = 0; i < 10; i += 1) {
      points.push({ name: "latency_ms", value: i, timestampMs: i * 1000 });
      points.push({ name: "token_usage", value: i, timestampMs: i * 1000 + 500 });
    }
    server.setMetrics(points);
    const result = await client.getMetrics({
      names: ["latency_ms", "token_usage"],
      fromMs: 0,
      toMs: Number.MAX_SAFE_INTEGER,
      limit: 3,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBe(3);
    // Newest-first: 9500, 9000, 8500.
    expect(result.value[0]?.timestampMs).toBe(9_500);
    expect(result.value[2]?.timestampMs).toBe(8_500);
  });

  test("listTraces: pagination follows nextCursor", async () => {
    const many: TraceView[] = [];
    for (let i = 0; i < 40; i += 1) many.push(makeTrace(`t-${i}`, "a1", i * 100));
    server.setTraces(many);
    let allItems: TraceView[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const result = await client.listTraces({
        agentId: agentId("a1"),
        limit: 25,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      allItems = allItems.concat(result.value.items);
      if (!result.value.nextCursor) break;
      cursor = result.value.nextCursor;
    }
    expect(allItems.length).toBe(40);
  });

  test("SSE subscribe: receives emitted events", async () => {
    server.setAgents([makeAgent("a1")]);
    const received: WsEvent[] = [];
    const unsubscribe = client.subscribe(["agent-status", "session-summary", "metric", "trace"], {
      onEvent: (event) => {
        received.push(event);
      },
    });
    // Give the subscription time to establish.
    await new Promise((resolve) => setTimeout(resolve, 50));
    server.emit({
      v: 1,
      kind: "agent-status",
      status: makeAgent("a1", { state: "idle", lastActivityAt: 5_000 }),
    });
    // Wait for SSE flush (server flushMs=5).
    await new Promise((resolve) => setTimeout(resolve, 100));
    unsubscribe();
    expect(received.length).toBeGreaterThanOrEqual(1);
    const first = received[0];
    expect(first?.kind).toBe("agent-status");
    if (first?.kind === "agent-status") {
      expect(first.status.agentId).toBe(agentId("a1"));
    }
  });

  test("orphan metric → session.summary drains buffer (full reducer flow)", async () => {
    const baseTimeMs = 100_000;
    const initial = createDashboardViewModel({
      generatedAt: new Date(baseTimeMs).toISOString(),
      agents: [
        {
          id: "a1",
          name: "a1",
          role: "Copilot",
          status: "running",
          region: "local",
          lastSeenAt: new Date(baseTimeMs).toISOString(),
        },
      ],
      sessions: [],
    });
    // Live metric arrives before session.summary.
    const orphanPoint: DashboardClientMetricPoint = {
      name: "latency_ms",
      value: 250,
      timestampMs: baseTimeMs,
      tags: { sessionId: "s-late" },
    };
    const buffered = applyDashboardEvent(initial, {
      type: "metric.received",
      points: [orphanPoint],
    });
    expect(buffered.pendingMetricsBySessionId["s-late"]?.length).toBe(1);
    // session.summary now arrives → buffer drains onto the new session.
    const summary: DashboardClientSessionSummary = {
      sessionId: "s-late",
      agentId: "a1",
      status: "active",
      turns: 1,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      startedAt: baseTimeMs - 1_000,
    };
    const drained = applyDashboardEvent(buffered, {
      type: "session.summary.received",
      session: summary,
      nowMs: baseTimeMs + 1_000,
    });
    expect(drained.pendingMetricsBySessionId["s-late"]).toBeUndefined();
    const latency = drained.sessionsById["s-late"]?.metrics.find((m) => m.label === "Latency Ms");
    expect(latency?.value).toBe("250");
  });

  test("multi-session agent: trace pane stays at agent scope, latest turn wins", async () => {
    const baseTimeMs = 50_000;
    let state = createDashboardViewModel({
      generatedAt: new Date(baseTimeMs).toISOString(),
      agents: [
        {
          id: "a1",
          name: "a1",
          role: "Copilot",
          status: "running",
          region: "local",
          lastSeenAt: new Date(baseTimeMs).toISOString(),
        },
      ],
      sessions: [
        {
          id: "s-a",
          agentId: "a1",
          title: "S A",
          summary: "active",
          status: "active",
          startedAt: new Date(baseTimeMs - 60_000).toISOString(),
          updatedAt: new Date(baseTimeMs).toISOString(),
          durationMs: 60_000,
          trace: [],
          metrics: [],
        },
        {
          id: "s-b",
          agentId: "a1",
          title: "S B",
          summary: "active",
          status: "active",
          startedAt: new Date(baseTimeMs - 30_000).toISOString(),
          updatedAt: new Date(baseTimeMs).toISOString(),
          durationMs: 30_000,
          trace: [],
          metrics: [],
        },
      ],
    });
    state = applyDashboardEvent(state, {
      type: "trace.received",
      trace: makeTrace("turn-1", "a1", baseTimeMs) as never,
    });
    state = applyDashboardEvent(state, {
      type: "trace.received",
      trace: makeTrace("turn-old", "a1", baseTimeMs - 10_000) as never,
    });
    expect(state.latestTurnByAgentId.a1?.turnId).toBe("turn-1");
    expect(state.selectedAgentTrace.length).toBeGreaterThan(0);
    // Sessions remain untouched — never guess a session for a trace.
    expect(state.sessionsById["s-a"]?.trace).toEqual([]);
    expect(state.sessionsById["s-b"]?.trace).toEqual([]);
  });
});
