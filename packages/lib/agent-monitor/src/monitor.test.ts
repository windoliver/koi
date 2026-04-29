import { describe, expect, test } from "bun:test";
import type {
  AnomalySignal,
  ModelChunk,
  ModelRequest,
  SessionContext,
  SessionId,
  ToolRequest,
  ToolResponse,
  TurnContext,
  TurnId,
} from "@koi/core";
import { runId, sessionId, turnId } from "@koi/core";
import { createAgentMonitorMiddleware } from "./monitor.js";

function makeSession(id = "s1"): SessionContext {
  return {
    agentId: "agent-x",
    sessionId: sessionId(id) as SessionId,
    runId: runId("r1"),
    metadata: {},
  };
}

function makeTurn(session: SessionContext, idx: number): TurnContext {
  return {
    session,
    turnIndex: idx,
    turnId: turnId(session.runId, idx) as TurnId,
    messages: [],
    metadata: {},
  };
}

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe("createAgentMonitorMiddleware", () => {
  test("name + priority", () => {
    const mw = createAgentMonitorMiddleware({});
    expect(mw.name).toBe("agent-monitor");
    expect(mw.priority).toBe(350);
  });

  test("rejects invalid config at construction", () => {
    expect(() =>
      createAgentMonitorMiddleware({
        thresholds: { maxToolCallsPerTurn: -1 },
      }),
    ).toThrow(/agent-monitor config invalid/);
  });

  test("tool_rate_exceeded fires after >maxToolCallsPerTurn calls", async () => {
    const signals: AnomalySignal[] = [];
    const mw = createAgentMonitorMiddleware({
      thresholds: { maxToolCallsPerTurn: 2 },
      onAnomaly: (s) => {
        signals.push(s);
      },
    });
    const session = makeSession();
    await mw.onSessionStart!(session);
    const ctx = makeTurn(session, 0);
    await mw.onBeforeTurn!(ctx);
    const next = async (_r: ToolRequest): Promise<ToolResponse> => ({ output: "ok" });
    for (let i = 0; i < 3; i++) {
      await mw.wrapToolCall!(ctx, { toolId: `t${i}`, input: {} } as ToolRequest, next);
    }
    await tick();
    expect(signals.some((s) => s.kind === "tool_rate_exceeded")).toBe(true);
  });

  test("tool_repeated fires when same tool called repeatedly", async () => {
    const signals: AnomalySignal[] = [];
    const mw = createAgentMonitorMiddleware({
      thresholds: { maxConsecutiveRepeatCalls: 2 },
      onAnomaly: (s) => {
        signals.push(s);
      },
    });
    const session = makeSession();
    await mw.onSessionStart!(session);
    const ctx = makeTurn(session, 0);
    await mw.onBeforeTurn!(ctx);
    const next = async (_r: ToolRequest): Promise<ToolResponse> => ({ output: "ok" });
    for (let i = 0; i < 3; i++) {
      await mw.wrapToolCall!(ctx, { toolId: "same", input: {} } as ToolRequest, next);
    }
    await tick();
    expect(signals.some((s) => s.kind === "tool_repeated")).toBe(true);
  });

  test("irreversible_action_rate fires when destructive tool exceeds limit", async () => {
    const signals: AnomalySignal[] = [];
    const mw = createAgentMonitorMiddleware({
      destructiveToolIds: ["delete"],
      thresholds: { maxDestructiveCallsPerTurn: 1 },
      onAnomaly: (s) => {
        signals.push(s);
      },
    });
    const session = makeSession();
    await mw.onSessionStart!(session);
    const ctx = makeTurn(session, 0);
    await mw.onBeforeTurn!(ctx);
    const next = async (_r: ToolRequest): Promise<ToolResponse> => ({ output: "ok" });
    for (let i = 0; i < 2; i++) {
      await mw.wrapToolCall!(ctx, { toolId: "delete", input: {} } as ToolRequest, next);
    }
    await tick();
    expect(signals.some((s) => s.kind === "irreversible_action_rate")).toBe(true);
  });

  test("delegation_depth_exceeded fires when at max depth", async () => {
    const signals: AnomalySignal[] = [];
    const mw = createAgentMonitorMiddleware({
      spawnToolIds: ["spawn"],
      agentDepth: 3,
      thresholds: { maxDelegationDepth: 3 },
      onAnomaly: (s) => {
        signals.push(s);
      },
    });
    const session = makeSession();
    await mw.onSessionStart!(session);
    const ctx = makeTurn(session, 0);
    await mw.onBeforeTurn!(ctx);
    await mw.wrapToolCall!(ctx, { toolId: "spawn", input: {} } as ToolRequest, async () => ({
      output: "ok",
    }));
    await tick();
    expect(signals.some((s) => s.kind === "delegation_depth_exceeded")).toBe(true);
  });

  test("error_spike fires when next() throws", async () => {
    const signals: AnomalySignal[] = [];
    const mw = createAgentMonitorMiddleware({
      thresholds: { maxErrorCallsPerSession: 1 },
      onAnomaly: (s) => {
        signals.push(s);
      },
    });
    const session = makeSession();
    await mw.onSessionStart!(session);
    const ctx = makeTurn(session, 0);
    await mw.onBeforeTurn!(ctx);
    const next = async (_r: ToolRequest): Promise<ToolResponse> => {
      throw new Error("boom");
    };
    for (let i = 0; i < 2; i++) {
      try {
        await mw.wrapToolCall!(ctx, { toolId: `t${i}`, input: {} } as ToolRequest, next);
      } catch {
        /* expected */
      }
    }
    await tick();
    expect(signals.some((s) => s.kind === "error_spike")).toBe(true);
  });

  test("denied_tool_calls fires via onPermissionDecision", async () => {
    const signals: AnomalySignal[] = [];
    const mw = createAgentMonitorMiddleware({
      thresholds: { maxDeniedCallsPerSession: 1 },
      onAnomaly: (s) => {
        signals.push(s);
      },
    });
    const session = makeSession();
    await mw.onSessionStart!(session);
    const ctx = makeTurn(session, 0);
    await mw.onBeforeTurn!(ctx);
    for (let i = 0; i < 2; i++) {
      mw.onPermissionDecision!(
        ctx,
        { toolId: "t", input: {}, kind: "tool_call" } as never,
        { effect: "deny", reason: "no" } as never,
      );
    }
    await tick();
    expect(signals.some((s) => s.kind === "denied_tool_calls")).toBe(true);
  });

  test("model_latency_anomaly fires after warm-up + outlier", async () => {
    const signals: AnomalySignal[] = [];
    const mw = createAgentMonitorMiddleware({
      thresholds: { latencyAnomalyFactor: 1, minLatencySamples: 3 },
      onAnomaly: (s) => {
        signals.push(s);
      },
    });
    const session = makeSession();
    await mw.onSessionStart!(session);
    const ctx = makeTurn(session, 0);
    await mw.onBeforeTurn!(ctx);

    async function* fastStream(): AsyncIterable<ModelChunk> {
      yield { kind: "usage", inputTokens: 10, outputTokens: 50 };
    }
    async function* slowStream(): AsyncIterable<ModelChunk> {
      await new Promise((r) => setTimeout(r, 50));
      yield { kind: "usage", inputTokens: 10, outputTokens: 50 };
    }
    for (let i = 0; i < 3; i++) {
      const it = mw.wrapModelStream!(ctx, {} as ModelRequest, fastStream);
      for await (const _ of it) {
        /* drain */
      }
    }
    const it = mw.wrapModelStream!(ctx, {} as ModelRequest, slowStream);
    for await (const _ of it) {
      /* drain */
    }
    await tick();
    expect(signals.some((s) => s.kind === "model_latency_anomaly")).toBe(true);
  });

  test("onSessionEnd emits onMetrics summary and clears state", async () => {
    let captured: unknown = null;
    const mw = createAgentMonitorMiddleware({
      onMetrics: (_id, summary) => {
        captured = summary;
      },
    });
    const session = makeSession();
    await mw.onSessionStart!(session);
    const ctx = makeTurn(session, 0);
    await mw.onBeforeTurn!(ctx);
    await mw.wrapToolCall!(ctx, { toolId: "x", input: {} } as ToolRequest, async () => ({
      output: "ok",
    }));
    await mw.onSessionEnd!(session);
    expect(captured).not.toBeNull();
  });

  test("goal_drift fires when no tool calls match objectives", async () => {
    const signals: AnomalySignal[] = [];
    const mw = createAgentMonitorMiddleware({
      objectives: ["search the web"],
      goalDrift: { threshold: 1.0 },
      onAnomaly: (s) => {
        signals.push(s);
      },
    });
    const session = makeSession();
    await mw.onSessionStart!(session);
    const t1 = makeTurn(session, 0);
    await mw.onBeforeTurn!(t1);
    await mw.wrapToolCall!(t1, { toolId: "email_send", input: {} } as ToolRequest, async () => ({
      output: "ok",
    }));
    const t2 = makeTurn(session, 1);
    await mw.onBeforeTurn!(t2);
    await tick();
    expect(signals.some((s) => s.kind === "goal_drift")).toBe(true);
  });

  test("goal_drift suppressed when tool matches keyword", async () => {
    const signals: AnomalySignal[] = [];
    const mw = createAgentMonitorMiddleware({
      objectives: ["search the web"],
      goalDrift: { threshold: 1.0 },
      onAnomaly: (s) => {
        signals.push(s);
      },
    });
    const session = makeSession();
    await mw.onSessionStart!(session);
    const t1 = makeTurn(session, 0);
    await mw.onBeforeTurn!(t1);
    await mw.wrapToolCall!(t1, { toolId: "web_search", input: {} } as ToolRequest, async () => ({
      output: "ok",
    }));
    const t2 = makeTurn(session, 1);
    await mw.onBeforeTurn!(t2);
    await tick();
    expect(signals.some((s) => s.kind === "goal_drift")).toBe(false);
  });

  test("onAnomaly errors route to onAnomalyError", async () => {
    const errors: unknown[] = [];
    const mw = createAgentMonitorMiddleware({
      thresholds: { maxToolCallsPerTurn: 0 },
      onAnomaly: () => {
        throw new Error("cb-fail");
      },
      onAnomalyError: (err) => errors.push(err),
    });
    const session = makeSession();
    await mw.onSessionStart!(session);
    const ctx = makeTurn(session, 0);
    await mw.onBeforeTurn!(ctx);
    await mw.wrapToolCall!(ctx, { toolId: "x", input: {} } as ToolRequest, async () => ({
      output: "ok",
    }));
    await tick();
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });
});
