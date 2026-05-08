import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DashboardView,
  fetchSessionMetrics,
  loadDashboardSnapshot,
  type DashboardClient,
} from "../app.js";
import { EmptyState } from "../components/empty-state.js";
import { ErrorState } from "../components/error-state.js";
import { LoadingState } from "../components/loading-state.js";
import { MetricsPanel } from "../components/metrics-panel.js";
import { SessionDetail } from "../components/session-detail.js";
import { TraceViewer } from "../components/trace-viewer.js";
import { demoDashboardData } from "../lib/demo-data.js";
import { formatDuration, formatRelativeMinutes, formatTimestamp } from "../lib/format.js";
import { applyDashboardEvent, createDashboardViewModel, createEmptyDashboardViewModel } from "../lib/state.js";

function createFakeDashboardClient(): DashboardClient {
  return {
    listAgents: async () => ({
      ok: true,
      value: {
        items: [
          {
            agentId: "agent-orchid" as never,
            name: "Orchid",
            state: "running",
            agentType: "copilot",
            model: "gpt-5.4",
            channels: ["local"],
            turns: 12,
            tokenCount: 148_000,
            startedAt: Date.parse("2026-05-07T21:30:00.000Z"),
            lastActivityAt: Date.parse("2026-05-07T22:14:42.000Z"),
            childCount: 0,
          },
        ],
      },
    }),
    getAgent: async () => ({ ok: true, value: undefined }),
    listSessions: async () => ({
      ok: true,
      value: {
        items: [
          {
            sessionId: "session-orchid-2" as never,
            agentId: "agent-orchid" as never,
            status: "active",
            turns: 8,
            inputTokens: 1024,
            outputTokens: 256,
            costUsd: 1.25,
            startedAt: Date.parse("2026-05-07T21:56:00.000Z"),
          },
        ],
      },
    }),
    getMetrics: async () => ({
      ok: true,
      value: [
        {
          name: "token_usage",
          value: 148000,
          timestampMs: Date.parse("2026-05-07T22:14:40.000Z"),
          tags: { sessionId: "session-orchid-2" },
        },
      ],
    }),
    getTrace: async () => ({ ok: true, value: undefined }),
    subscribe: () => () => undefined,
  };
}

describe("DashboardApp", () => {
  test("loads snapshot data from the injected client and renders it", async () => {
    const client = createFakeDashboardClient();
    const nowMs = Date.parse("2026-05-07T22:15:00.000Z");
    const snapshot = await loadDashboardSnapshot(client, { nowMs });
    let state = createDashboardViewModel(snapshot);
    const sessionId = state.selectedSessionId;
    if (sessionId) {
      const points = await fetchSessionMetrics(client, sessionId, nowMs);
      if (points && points.length > 0) {
        state = applyDashboardEvent(state, { type: "metric.received", points });
      }
    }
    const markup = renderToStaticMarkup(<DashboardView state={state} dispatch={() => undefined} />);

    expect(markup).toContain("Koi Dashboard");
    expect(markup).toContain("Agents");
    expect(markup).toContain("Session detail");
    expect(markup).toContain("Trace");
    expect(markup).toContain("Orchid");
    expect(markup).toContain("session-orchid-2");
    expect(markup).toContain("Token Usage");
  });

  test("renders local empty, error, and loading states", () => {
    const markup = renderToStaticMarkup(
      <>
        <LoadingState label="Hydrating demo data..." />
        <ErrorState message="Demo fleet failed to load." />
        <EmptyState title="Nothing selected" message="Choose an agent from the fleet." />
      </>,
    );

    expect(markup).toContain("Hydrating demo data...");
    expect(markup).toContain("Demo fleet failed to load.");
    expect(markup).toContain("Nothing selected");
  });

  test("renders fallback views for empty metrics, empty trace, and missing session", () => {
    const markup = renderToStaticMarkup(
      <>
        <SessionDetail selectedSession={null} visibleSessions={[]} onSelectSession={() => {}} />
        <MetricsPanel metrics={[]} />
        <TraceViewer trace={[]} />
      </>,
    );

    expect(markup).toContain("No session selected");
    expect(markup).toContain("No metrics collected");
    expect(markup).toContain("No trace events yet");
  });

  test("formats timestamps and durations for the session detail surfaces", () => {
    expect(formatTimestamp("2026-05-07T22:14:40.000Z")).toContain("May");
    expect(formatRelativeMinutes("2026-05-07T22:10:40.000Z", "2026-05-07T22:14:40.000Z")).toBe(
      "4m ago",
    );
    expect(formatRelativeMinutes("2026-05-07T20:14:40.000Z", "2026-05-07T22:14:40.000Z")).toBe(
      "2h ago",
    );
    expect(formatRelativeMinutes("2026-05-07T20:09:40.000Z", "2026-05-07T22:14:40.000Z")).toBe(
      "2h 5m ago",
    );
    expect(formatDuration(30 * 60_000)).toBe("30m");
    expect(formatDuration(2 * 60 * 60_000)).toBe("2h");
    expect(formatDuration(125 * 60_000)).toBe("2h 5m");
  });

  test("renders alternate agent sessions from the derived local view model", () => {
    const state = createDashboardViewModel(demoDashboardData);
    const markup = renderToStaticMarkup(
      <SessionDetail
        selectedSession={state.selectedSession}
        visibleSessions={state.visibleSessions}
        onSelectSession={() => {}}
      />,
    );

    expect(markup).toContain("Dashboard shell smoke pass");
    expect(markup).toContain("Automation guardrail review");
  });

  test("routes trace events at agent scope for agents with multiple sessions", () => {
    const baseTimeMs = Date.parse("2026-05-07T22:14:40.000Z");
    const snapshot = {
      generatedAt: new Date(baseTimeMs).toISOString(),
      agents: [
        {
          id: "agent-orchid",
          name: "Orchid",
          role: "Copilot",
          status: "running" as const,
          region: "local",
          lastSeenAt: new Date(baseTimeMs).toISOString(),
        },
      ],
      sessions: [
        {
          id: "session-a",
          agentId: "agent-orchid",
          title: "Session session-a",
          summary: "Active",
          status: "active" as const,
          startedAt: new Date(baseTimeMs - 60_000).toISOString(),
          updatedAt: new Date(baseTimeMs).toISOString(),
          durationMs: 60_000,
          trace: [],
          metrics: [],
        },
        {
          id: "session-b",
          agentId: "agent-orchid",
          title: "Session session-b",
          summary: "Active",
          status: "active" as const,
          startedAt: new Date(baseTimeMs - 30_000).toISOString(),
          updatedAt: new Date(baseTimeMs).toISOString(),
          durationMs: 30_000,
          trace: [],
          metrics: [],
        },
      ],
    };
    const initial = createDashboardViewModel(snapshot);
    const traced = applyDashboardEvent(initial, {
      type: "trace.received",
      trace: {
        turnId: "turn-1" as never,
        agentId: "agent-orchid" as never,
        turnIndex: 0,
        startedAtMs: baseTimeMs,
        totalDurationMs: 1_000,
        root: {
          spanId: "root",
          name: "root",
          category: "model",
          startedAtMs: baseTimeMs,
          durationMs: 1_000,
          children: [
            {
              spanId: "child",
              name: "model.invoke",
              category: "model",
              startedAtMs: baseTimeMs,
              durationMs: 1_000,
              children: [],
            },
          ],
        },
      },
    });

    // Trace caches at agent scope keyed by turnId regardless of session count.
    expect(traced.tracesByTurnId["turn-1"]?.length).toBeGreaterThan(0);
    expect(traced.latestTurnByAgentId["agent-orchid"]?.turnId).toBe("turn-1");
    expect(traced.selectedAgentTrace.length).toBeGreaterThan(0);
    // Sessions remain untouched — we never guess a session for a trace.
    expect(traced.sessionsById["session-a"]?.trace).toEqual([]);
    expect(traced.sessionsById["session-b"]?.trace).toEqual([]);
  });

  test("does not roll back the agent trace pointer when an older trace arrives later", () => {
    const baseTimeMs = Date.parse("2026-05-07T22:14:40.000Z");
    const snapshot = {
      generatedAt: new Date(baseTimeMs).toISOString(),
      agents: [
        {
          id: "agent-orchid",
          name: "Orchid",
          role: "Copilot",
          status: "running" as const,
          region: "local",
          lastSeenAt: new Date(baseTimeMs).toISOString(),
        },
      ],
      sessions: [],
    };
    const initial = createDashboardViewModel(snapshot);
    const newer = applyDashboardEvent(initial, {
      type: "trace.received",
      trace: {
        turnId: "turn-new" as never,
        agentId: "agent-orchid" as never,
        turnIndex: 1,
        startedAtMs: baseTimeMs,
        totalDurationMs: 1_000,
        root: {
          spanId: "root",
          name: "root",
          category: "model",
          startedAtMs: baseTimeMs,
          durationMs: 1_000,
          children: [
            {
              spanId: "child-new",
              name: "model.invoke",
              category: "model",
              startedAtMs: baseTimeMs,
              durationMs: 1_000,
              children: [],
            },
          ],
        },
      },
    });
    const olderArrivingLate = applyDashboardEvent(newer, {
      type: "trace.received",
      trace: {
        turnId: "turn-old" as never,
        agentId: "agent-orchid" as never,
        turnIndex: 0,
        startedAtMs: baseTimeMs - 60_000,
        totalDurationMs: 1_000,
        root: {
          spanId: "root",
          name: "root",
          category: "model",
          startedAtMs: baseTimeMs - 60_000,
          durationMs: 1_000,
          children: [
            {
              spanId: "child-old",
              name: "model.invoke",
              category: "model",
              startedAtMs: baseTimeMs - 60_000,
              durationMs: 1_000,
              children: [],
            },
          ],
        },
      },
    });

    // Pointer must remain on the newer turn even though an older history item arrived.
    expect(olderArrivingLate.latestTurnByAgentId["agent-orchid"]?.turnId).toBe("turn-new");
    // Both traces are still cached for direct lookup if needed.
    expect(olderArrivingLate.tracesByTurnId["turn-old"]).toBeDefined();
    expect(olderArrivingLate.tracesByTurnId["turn-new"]).toBeDefined();
  });

  test("does not let an older metric sample overwrite a newer same-label sample", () => {
    const baseTimeMs = Date.parse("2026-05-07T22:14:40.000Z");
    const snapshot = {
      generatedAt: new Date(baseTimeMs).toISOString(),
      agents: [
        {
          id: "agent-orchid",
          name: "Orchid",
          role: "Copilot",
          status: "running" as const,
          region: "local",
          lastSeenAt: new Date(baseTimeMs).toISOString(),
        },
      ],
      sessions: [
        {
          id: "session-a",
          agentId: "agent-orchid",
          title: "Session session-a",
          summary: "Active",
          status: "active" as const,
          startedAt: new Date(baseTimeMs - 60_000).toISOString(),
          updatedAt: new Date(baseTimeMs).toISOString(),
          durationMs: 60_000,
          trace: [],
          metrics: [],
        },
      ],
    };
    const initial = createDashboardViewModel(snapshot);
    const live = applyDashboardEvent(initial, {
      type: "metric.received",
      points: [
        {
          name: "latency_ms",
          value: 1500,
          timestampMs: baseTimeMs + 60_000,
          tags: { sessionId: "session-a" },
        },
      ],
    });
    const lateHistory = applyDashboardEvent(live, {
      type: "metric.received",
      points: [
        {
          name: "latency_ms",
          value: 100,
          timestampMs: baseTimeMs - 60_000,
          tags: { sessionId: "session-a" },
        },
      ],
    });
    const latency = lateHistory.sessionsById["session-a"]?.metrics.find(
      (metric) => metric.label === "Latency Ms",
    );
    expect(latency?.value).toBe("1,500");
  });

  test("loadDashboardSnapshot follows nextCursor across multi-page list responses", async () => {
    const agentPages = [
      {
        items: [
          {
            agentId: "agent-1" as never,
            name: "One",
            state: "running",
            agentType: "copilot",
            channels: [],
            turns: 0,
            tokenCount: 0,
            startedAt: 0,
            lastActivityAt: 0,
            childCount: 0,
          },
        ],
        nextCursor: "agent-2",
      },
      {
        items: [
          {
            agentId: "agent-2" as never,
            name: "Two",
            state: "idle",
            agentType: "copilot",
            channels: [],
            turns: 0,
            tokenCount: 0,
            startedAt: 0,
            lastActivityAt: 0,
            childCount: 0,
          },
        ],
      },
    ];
    let agentCallIndex = 0;
    const client: DashboardClient = {
      listAgents: async () => {
        const page = agentPages[agentCallIndex++];
        return { ok: true, value: page ?? { items: [] } };
      },
      getAgent: async () => ({ ok: true, value: undefined }),
      listSessions: async () => ({ ok: true, value: { items: [] } }),
      getMetrics: async () => ({ ok: true, value: [] }),
      getTrace: async () => ({ ok: true, value: undefined }),
      subscribe: () => () => undefined,
    };
    const snapshot = await loadDashboardSnapshot(client, {
      nowMs: Date.parse("2026-05-07T22:15:00.000Z"),
    });
    expect(snapshot.agents.length).toBe(2);
    expect(snapshot.agents.map((a) => a.id)).toEqual(["agent-1", "agent-2"]);
    expect(agentCallIndex).toBe(2);
  });

  test("buffers orphan metric points until the matching session.summary arrives", () => {
    const baseTimeMs = Date.parse("2026-05-07T22:14:40.000Z");
    const initial = createDashboardViewModel({
      generatedAt: new Date(baseTimeMs).toISOString(),
      agents: [
        {
          id: "agent-orchid",
          name: "Orchid",
          role: "Copilot",
          status: "running" as const,
          region: "local",
          lastSeenAt: new Date(baseTimeMs).toISOString(),
        },
      ],
      sessions: [],
    });
    const orphaned = applyDashboardEvent(initial, {
      type: "metric.received",
      points: [
        {
          name: "latency_ms",
          value: 999,
          timestampMs: baseTimeMs,
          tags: { sessionId: "session-late" },
        },
      ],
    });
    // Buffered, not dropped, not applied to any existing session.
    expect(orphaned.pendingMetricsBySessionId["session-late"]?.length).toBe(1);
    expect(orphaned.sessionsById["session-late"]).toBeUndefined();

    const sessionArrived = applyDashboardEvent(orphaned, {
      type: "session.summary.received",
      session: {
        sessionId: "session-late",
        agentId: "agent-orchid",
        status: "active",
        turns: 1,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        startedAt: baseTimeMs - 5_000,
      },
      nowMs: baseTimeMs,
    });
    // Orphaned point is now attached to the new session, and the buffer is drained.
    expect(sessionArrived.pendingMetricsBySessionId["session-late"]).toBeUndefined();
    const latency = sessionArrived.sessionsById["session-late"]?.metrics.find(
      (metric) => metric.label === "Latency Ms",
    );
    expect(latency?.value).toBe("999");
  });

  test("ignores metric points that lack an explicit sessionId tag", () => {
    const baseTimeMs = Date.parse("2026-05-07T22:14:40.000Z");
    const snapshot = {
      generatedAt: new Date(baseTimeMs).toISOString(),
      agents: [
        {
          id: "agent-orchid",
          name: "Orchid",
          role: "Copilot",
          status: "running" as const,
          region: "local",
          lastSeenAt: new Date(baseTimeMs).toISOString(),
        },
      ],
      sessions: [
        {
          id: "session-a",
          agentId: "agent-orchid",
          title: "Session session-a",
          summary: "Active",
          status: "active" as const,
          startedAt: new Date(baseTimeMs - 60_000).toISOString(),
          updatedAt: new Date(baseTimeMs).toISOString(),
          durationMs: 60_000,
          trace: [],
          metrics: [],
        },
      ],
    };
    const initial = createDashboardViewModel(snapshot);
    const next = applyDashboardEvent(initial, {
      type: "metric.received",
      points: [
        {
          name: "latency_ms",
          value: 999,
          timestampMs: baseTimeMs,
          tags: { agentId: "agent-orchid" },
        },
      ],
    });
    // No sessionId tag — must not be routed to any session.
    expect(next.sessionsById["session-a"]?.metrics).toEqual([]);
    expect(next.sessionsById["session-a"]?.updatedAt).toBe(initial.sessionsById["session-a"]?.updatedAt);
  });

  test("applies a live metric event and updates the rendered UI", async () => {
    const snapshot = await loadDashboardSnapshot(createFakeDashboardClient(), {
      nowMs: Date.parse("2026-05-07T22:15:00.000Z"),
    });
    const hydratedState = applyDashboardEvent(createEmptyDashboardViewModel(), {
      type: "snapshot.loaded",
      snapshot,
    });
    const updatedState = applyDashboardEvent(hydratedState, {
      type: "metric.received",
      points: [
        {
          name: "latency_ms",
          value: 1200,
          timestampMs: Date.parse("2026-05-07T22:16:00.000Z"),
          tags: { sessionId: "session-orchid-2" },
        },
      ],
    });
    const markup = renderToStaticMarkup(
      <DashboardView state={updatedState} dispatch={() => undefined} />,
    );

    expect(markup).toContain("Latency Ms");
    expect(markup).toContain("1,200");
  });
});
