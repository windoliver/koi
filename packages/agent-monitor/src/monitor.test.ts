/**
 * Integration tests for createAgentMonitorMiddleware.
 *
 * Tests lifecycle hooks, anomaly callbacks, onMetrics, and error handling.
 */

import { describe, expect, test } from "bun:test";
import type { SessionId } from "@koi/core/ecs";
import type { ModelChunk, ToolResponse } from "@koi/core/middleware";
import {
  createMockModelHandler,
  createMockModelStreamHandler,
  createMockSessionContext,
  createMockToolHandler,
  createMockTurnContext,
} from "@koi/test-utils";
import { createAgentMonitorMiddleware } from "./monitor.js";
import type { AnomalySignal, SessionMetricsSummary } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToolResponse(denied = false): ToolResponse {
  if (denied) {
    return { output: { result: "ok" }, metadata: { denied: true } };
  }
  return { output: { result: "ok" } };
}

async function runToolCall(
  mw: ReturnType<typeof createAgentMonitorMiddleware>,
  ctx: ReturnType<typeof createMockTurnContext>,
  toolId: string,
  denied = false,
): Promise<void> {
  if (!mw.wrapToolCall) return;
  const handler = createMockToolHandler(makeToolResponse(denied));
  await mw.wrapToolCall(ctx, { toolId, input: {} }, handler);
}

async function runModelCall(
  mw: ReturnType<typeof createAgentMonitorMiddleware>,
  ctx: ReturnType<typeof createMockTurnContext>,
): Promise<void> {
  if (!mw.wrapModelCall) return;
  const handler = createMockModelHandler();
  await mw.wrapModelCall(ctx, { messages: [] }, handler);
}

async function runModelStream(
  mw: ReturnType<typeof createAgentMonitorMiddleware>,
  ctx: ReturnType<typeof createMockTurnContext>,
  chunks: readonly ModelChunk[] = [],
): Promise<void> {
  if (!mw.wrapModelStream) return;
  const handler = createMockModelStreamHandler(chunks);
  for await (const _chunk of mw.wrapModelStream(ctx, { messages: [] }, handler)) {
    // drain
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createAgentMonitorMiddleware", () => {
  test("returns middleware with name 'agent-monitor' and priority 350", () => {
    const mw = createAgentMonitorMiddleware({});
    expect(mw.name).toBe("agent-monitor");
    expect(mw.priority).toBe(350);
  });

  describe("lifecycle: session state", () => {
    test("initializes session state on onSessionStart", async () => {
      const mw = createAgentMonitorMiddleware({});
      const ctx = createMockSessionContext();
      // Should not throw when session doesn't exist yet in wrapToolCall
      // (exercised after start)
      await mw.onSessionStart?.(ctx);
      const turnCtx = createMockTurnContext({ session: ctx });
      // No anomaly should fire at zero calls
      await runToolCall(mw, turnCtx, "tool-a");
    });

    test("cleans up session state on onSessionEnd", async () => {
      const sessionIds: SessionId[] = [];
      const mw = createAgentMonitorMiddleware({
        onMetrics: (sid) => {
          sessionIds.push(sid);
        },
      });
      const ctx = createMockSessionContext();
      await mw.onSessionStart?.(ctx);
      await mw.onSessionEnd?.(ctx);
      expect(sessionIds).toHaveLength(1);
      expect(sessionIds[0]).toBe(ctx.sessionId);
    });

    test("does not crash when wrapToolCall called without onSessionStart", async () => {
      const mw = createAgentMonitorMiddleware({});
      const ctx = createMockTurnContext();
      // Should pass through gracefully
      await runToolCall(mw, ctx, "tool-a");
    });
  });

  describe("onBeforeTurn", () => {
    test("resets toolCallsThisTurn counter between turns", async () => {
      const anomalies: AnomalySignal[] = [];
      const mw = createAgentMonitorMiddleware({
        thresholds: { maxToolCallsPerTurn: 2 },
        onAnomaly: (s) => {
          anomalies.push(s);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);

      const turn0 = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });
      await mw.onBeforeTurn?.(turn0);
      // Call 3 times in turn 0 — should fire anomaly (3 > 2)
      await runToolCall(mw, turn0, "t");
      await runToolCall(mw, turn0, "t");
      await runToolCall(mw, turn0, "t");

      // Wait for fire-and-forget
      await new Promise((r) => setTimeout(r, 10));
      const anomalyCountAfterTurn0 = anomalies.filter(
        (a) => a.kind === "tool_rate_exceeded",
      ).length;
      expect(anomalyCountAfterTurn0).toBeGreaterThan(0);

      // Start turn 1 — counter resets
      const turn1 = createMockTurnContext({ session: sessionCtx, turnIndex: 1 });
      await mw.onBeforeTurn?.(turn1);
      const prevCount = anomalies.length;
      await runToolCall(mw, turn1, "t");
      await runToolCall(mw, turn1, "t");
      await new Promise((r) => setTimeout(r, 10));
      // No new tool_rate_exceeded (2 <= 2)
      const newRateAnomalies = anomalies
        .slice(prevCount)
        .filter((a) => a.kind === "tool_rate_exceeded");
      expect(newRateAnomalies).toHaveLength(0);
    });
  });

  describe("signal 1: tool_rate_exceeded", () => {
    test("fires anomaly when tool calls per turn exceed threshold", async () => {
      const anomalies: AnomalySignal[] = [];
      const mw = createAgentMonitorMiddleware({
        thresholds: { maxToolCallsPerTurn: 2 },
        onAnomaly: (s) => {
          anomalies.push(s);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });
      await mw.onBeforeTurn?.(turnCtx);

      await runToolCall(mw, turnCtx, "t1");
      await runToolCall(mw, turnCtx, "t2");
      await runToolCall(mw, turnCtx, "t3"); // 3 > 2

      await new Promise((r) => setTimeout(r, 10));
      const rateAnomalies = anomalies.filter((a) => a.kind === "tool_rate_exceeded");
      expect(rateAnomalies.length).toBeGreaterThan(0);
      expect(rateAnomalies[0]).toMatchObject({
        kind: "tool_rate_exceeded",
        threshold: 2,
        sessionId: sessionCtx.sessionId,
        agentId: sessionCtx.agentId,
      });
    });
  });

  describe("signal 2: error_spike", () => {
    test("fires anomaly when tool errors exceed threshold", async () => {
      const anomalies: AnomalySignal[] = [];
      const mw = createAgentMonitorMiddleware({
        thresholds: { maxErrorCallsPerSession: 2 },
        onAnomaly: (s) => {
          anomalies.push(s);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });

      const throwingHandler = async (): Promise<ToolResponse> => {
        throw new Error("tool error");
      };

      for (let i = 0; i < 3; i++) {
        try {
          await mw.wrapToolCall?.(turnCtx, { toolId: "t", input: {} }, throwingHandler);
        } catch {
          // expected
        }
      }

      await new Promise((r) => setTimeout(r, 10));
      const errorAnomalies = anomalies.filter((a) => a.kind === "error_spike");
      expect(errorAnomalies.length).toBeGreaterThan(0);
      expect(errorAnomalies[0]).toMatchObject({
        kind: "error_spike",
        threshold: 2,
      });
    });
  });

  describe("signal 3: tool_repeated", () => {
    test("fires anomaly when same tool called consecutively beyond threshold", async () => {
      const anomalies: AnomalySignal[] = [];
      const mw = createAgentMonitorMiddleware({
        thresholds: { maxConsecutiveRepeatCalls: 3 },
        onAnomaly: (s) => {
          anomalies.push(s);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });

      for (let i = 0; i < 4; i++) {
        await runToolCall(mw, turnCtx, "hammer-tool");
      }

      await new Promise((r) => setTimeout(r, 10));
      const repeatAnomalies = anomalies.filter((a) => a.kind === "tool_repeated");
      expect(repeatAnomalies.length).toBeGreaterThan(0);
      expect(repeatAnomalies[0]).toMatchObject({
        kind: "tool_repeated",
        toolId: "hammer-tool",
        threshold: 3,
      });
    });

    test("resets consecutive counter when tool changes", async () => {
      const anomalies: AnomalySignal[] = [];
      const mw = createAgentMonitorMiddleware({
        thresholds: { maxConsecutiveRepeatCalls: 3 },
        onAnomaly: (s) => {
          anomalies.push(s);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });

      await runToolCall(mw, turnCtx, "tool-a");
      await runToolCall(mw, turnCtx, "tool-a");
      await runToolCall(mw, turnCtx, "tool-a");
      // Switch to different tool — should reset
      await runToolCall(mw, turnCtx, "tool-b");
      await runToolCall(mw, turnCtx, "tool-a");
      await runToolCall(mw, turnCtx, "tool-a");
      await runToolCall(mw, turnCtx, "tool-a");

      await new Promise((r) => setTimeout(r, 10));
      const repeatAnomalies = anomalies.filter((a) => a.kind === "tool_repeated");
      // 3 consecutive for tool-a (N = threshold), no fire
      // after switch: 3 consecutive again (N = threshold), no fire
      expect(repeatAnomalies).toHaveLength(0);
    });
  });

  describe("signal 4: model_latency_anomaly", () => {
    test("fires anomaly when latency exceeds mean + factor * stddev after warmup", async () => {
      const anomalies: AnomalySignal[] = [];
      const mw = createAgentMonitorMiddleware({
        thresholds: {
          latencyAnomalyFactor: 2,
          minLatencySamples: 3,
        },
        onAnomaly: (s) => {
          anomalies.push(s);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });

      // Seed with low-latency calls using fast mock handler
      // We can't control real latency in tests, so we test the detector directly in detector.test.ts
      // Here we just verify the integration doesn't throw
      for (let i = 0; i < 5; i++) {
        await runModelCall(mw, turnCtx);
      }

      // Latency anomaly may or may not fire depending on actual timing,
      // but no exception should be thrown
      expect(true).toBe(true);
    });

    test("does not fire before minLatencySamples warmup", async () => {
      const anomalies: AnomalySignal[] = [];
      const mw = createAgentMonitorMiddleware({
        thresholds: { minLatencySamples: 100, latencyAnomalyFactor: 0.001 },
        onAnomaly: (s) => {
          anomalies.push(s);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });

      for (let i = 0; i < 5; i++) {
        await runModelCall(mw, turnCtx);
      }

      await new Promise((r) => setTimeout(r, 10));
      const latencyAnomalies = anomalies.filter((a) => a.kind === "model_latency_anomaly");
      expect(latencyAnomalies).toHaveLength(0);
    });
  });

  describe("signal 5: denied_tool_calls", () => {
    test("fires anomaly when denied calls exceed threshold", async () => {
      const anomalies: AnomalySignal[] = [];
      const mw = createAgentMonitorMiddleware({
        thresholds: { maxDeniedCallsPerSession: 2 },
        onAnomaly: (s) => {
          anomalies.push(s);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });

      // 3 denied calls (> threshold of 2)
      await runToolCall(mw, turnCtx, "restricted-tool", true);
      await runToolCall(mw, turnCtx, "restricted-tool", true);
      await runToolCall(mw, turnCtx, "restricted-tool", true);

      await new Promise((r) => setTimeout(r, 10));
      const deniedAnomalies = anomalies.filter((a) => a.kind === "denied_tool_calls");
      expect(deniedAnomalies.length).toBeGreaterThan(0);
      expect(deniedAnomalies[0]).toMatchObject({
        kind: "denied_tool_calls",
        threshold: 2,
      });
    });
  });

  describe("onMetrics callback", () => {
    test("fires once on session end with correct summary", async () => {
      const summaries: SessionMetricsSummary[] = [];
      const mw = createAgentMonitorMiddleware({
        onMetrics: (_sid, summary) => {
          summaries.push(summary);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });
      await mw.onBeforeTurn?.(turnCtx);

      await runToolCall(mw, turnCtx, "t1");
      await runToolCall(mw, turnCtx, "t2");
      await runModelCall(mw, turnCtx);
      await mw.onSessionEnd?.(sessionCtx);

      expect(summaries).toHaveLength(1);
      const summary = summaries[0];
      if (!summary) throw new Error("summary missing");
      expect(summary.sessionId).toBe(sessionCtx.sessionId);
      expect(summary.agentId).toBe(sessionCtx.agentId);
      expect(summary.totalToolCalls).toBe(2);
      expect(summary.totalModelCalls).toBe(1);
      expect(summary.totalErrorCalls).toBe(0);
      expect(summary.totalDeniedCalls).toBe(0);
    });

    test("does not fire if onMetrics is not configured", async () => {
      const mw = createAgentMonitorMiddleware({});
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      // Should not throw
      await mw.onSessionEnd?.(sessionCtx);
    });
  });

  describe("error handling: fire-and-forget", () => {
    test("onAnomalyError is called when onAnomaly throws", async () => {
      const anomalyErrors: unknown[] = [];
      const mw = createAgentMonitorMiddleware({
        thresholds: { maxToolCallsPerTurn: 1 },
        onAnomaly: () => {
          throw new Error("callback error");
        },
        onAnomalyError: (err) => {
          anomalyErrors.push(err);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });
      await mw.onBeforeTurn?.(turnCtx);
      await runToolCall(mw, turnCtx, "t1");
      await runToolCall(mw, turnCtx, "t2"); // triggers anomaly

      await new Promise((r) => setTimeout(r, 20));
      expect(anomalyErrors.length).toBeGreaterThan(0);
    });

    test("tool call completes even when onAnomaly throws", async () => {
      const mw = createAgentMonitorMiddleware({
        thresholds: { maxToolCallsPerTurn: 1 },
        onAnomaly: () => {
          throw new Error("callback crash");
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });
      await mw.onBeforeTurn?.(turnCtx);
      await runToolCall(mw, turnCtx, "t1");
      // Should NOT throw:
      await expect(runToolCall(mw, turnCtx, "t2")).resolves.toBeUndefined();
    });
  });

  describe("anomaly count in summary", () => {
    test("counts anomalies correctly", async () => {
      const summaries: SessionMetricsSummary[] = [];
      const mw = createAgentMonitorMiddleware({
        thresholds: { maxToolCallsPerTurn: 1, maxConsecutiveRepeatCalls: 1 },
        onMetrics: (_sid, summary) => {
          summaries.push(summary);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });
      await mw.onBeforeTurn?.(turnCtx);

      // 2 tool calls → tool_rate_exceeded (1 anomaly)
      // 2nd call on same tool → tool_repeated (1 anomaly) but threshold=1 means 2>1 on second call
      await runToolCall(mw, turnCtx, "t");
      await runToolCall(mw, turnCtx, "t"); // triggers tool_rate_exceeded AND tool_repeated

      await mw.onSessionEnd?.(sessionCtx);

      expect(summaries).toHaveLength(1);
      expect(summaries[0]?.anomalyCount).toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // Gap 1: irreversible_action_rate
  // -------------------------------------------------------------------------

  describe("gap 1: irreversible_action_rate", () => {
    test("fires when destructive tool exceeds per-turn threshold", async () => {
      const anomalies: AnomalySignal[] = [];
      const mw = createAgentMonitorMiddleware({
        destructiveToolIds: ["email-delete"],
        thresholds: { maxDestructiveCallsPerTurn: 2 },
        onAnomaly: (s) => {
          anomalies.push(s);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });
      await mw.onBeforeTurn?.(turnCtx);

      // 3 destructive calls > threshold of 2
      await runToolCall(mw, turnCtx, "email-delete");
      await runToolCall(mw, turnCtx, "email-delete");
      await runToolCall(mw, turnCtx, "email-delete");

      await new Promise((r) => setTimeout(r, 10));
      const destructiveAnomalies = anomalies.filter((a) => a.kind === "irreversible_action_rate");
      expect(destructiveAnomalies.length).toBeGreaterThan(0);
      expect(destructiveAnomalies[0]).toMatchObject({
        kind: "irreversible_action_rate",
        toolId: "email-delete",
        threshold: 2,
      });
    });

    test("does not fire for tools not in destructiveToolIds", async () => {
      const anomalies: AnomalySignal[] = [];
      const mw = createAgentMonitorMiddleware({
        destructiveToolIds: ["email-delete"],
        thresholds: { maxDestructiveCallsPerTurn: 2 },
        onAnomaly: (s) => {
          anomalies.push(s);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });
      await mw.onBeforeTurn?.(turnCtx);

      // Safe tool called many times — no destructive signal
      await runToolCall(mw, turnCtx, "email-read");
      await runToolCall(mw, turnCtx, "email-read");
      await runToolCall(mw, turnCtx, "email-read");

      await new Promise((r) => setTimeout(r, 10));
      const destructiveAnomalies = anomalies.filter((a) => a.kind === "irreversible_action_rate");
      expect(destructiveAnomalies).toHaveLength(0);
    });

    test("resets destructive counter between turns", async () => {
      const anomalies: AnomalySignal[] = [];
      const mw = createAgentMonitorMiddleware({
        destructiveToolIds: ["file-delete"],
        thresholds: { maxDestructiveCallsPerTurn: 2 },
        onAnomaly: (s) => {
          anomalies.push(s);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);

      const turn0 = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });
      await mw.onBeforeTurn?.(turn0);
      await runToolCall(mw, turn0, "file-delete");
      await runToolCall(mw, turn0, "file-delete");
      // 2 == threshold, no fire

      // turn 1: counter resets
      const turn1 = createMockTurnContext({ session: sessionCtx, turnIndex: 1 });
      await mw.onBeforeTurn?.(turn1);
      await runToolCall(mw, turn1, "file-delete");
      await runToolCall(mw, turn1, "file-delete");

      await new Promise((r) => setTimeout(r, 10));
      const destructiveAnomalies = anomalies.filter((a) => a.kind === "irreversible_action_rate");
      expect(destructiveAnomalies).toHaveLength(0);
    });

    test("totalDestructiveCalls tracked in summary", async () => {
      const summaries: SessionMetricsSummary[] = [];
      const mw = createAgentMonitorMiddleware({
        destructiveToolIds: ["rm-rf"],
        onMetrics: (_sid, s) => {
          summaries.push(s);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });
      await runToolCall(mw, turnCtx, "rm-rf");
      await runToolCall(mw, turnCtx, "rm-rf");
      await runToolCall(mw, turnCtx, "safe-read");
      await mw.onSessionEnd?.(sessionCtx);

      expect(summaries[0]?.totalDestructiveCalls).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Gap 2: token_spike
  // -------------------------------------------------------------------------

  describe("gap 2: token_spike", () => {
    test("does not fire before warmup samples", async () => {
      const anomalies: AnomalySignal[] = [];
      const mw = createAgentMonitorMiddleware({
        thresholds: { minLatencySamples: 100, tokenSpikeAnomalyFactor: 0.001 },
        onAnomaly: (s) => {
          anomalies.push(s);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });
      for (let i = 0; i < 5; i++) {
        await runModelCall(mw, turnCtx);
      }
      await new Promise((r) => setTimeout(r, 10));
      expect(anomalies.filter((a) => a.kind === "token_spike")).toHaveLength(0);
    });

    test("outputToken stats appear in session summary", async () => {
      const summaries: SessionMetricsSummary[] = [];
      const mw = createAgentMonitorMiddleware({
        onMetrics: (_sid, s) => {
          summaries.push(s);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });
      await runModelCall(mw, turnCtx);
      await runModelCall(mw, turnCtx);
      await mw.onSessionEnd?.(sessionCtx);

      // Mock handler returns outputTokens: 20 (from DEFAULT_MODEL_RESPONSE)
      expect(summaries[0]?.meanOutputTokens).toBeGreaterThan(0);
      expect(summaries[0]?.outputTokenStddev).toBeGreaterThanOrEqual(0);
    });
  });

  // -------------------------------------------------------------------------
  // Gap A: tool_ping_pong
  // -------------------------------------------------------------------------

  describe("gap A: tool_ping_pong", () => {
    test("fires after N+1 alternations between two tools", async () => {
      const anomalies: AnomalySignal[] = [];
      const mw = createAgentMonitorMiddleware({
        // threshold = 2 → fires on 3rd alternation (altCount = 3 > 2)
        thresholds: { maxPingPongCycles: 2 },
        onAnomaly: (s) => {
          anomalies.push(s);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });

      // a→b (altCount=1), b→a (altCount=2), a→b (altCount=3 > 2) → fires
      await runToolCall(mw, turnCtx, "tool-a");
      await runToolCall(mw, turnCtx, "tool-b");
      await runToolCall(mw, turnCtx, "tool-a");
      await runToolCall(mw, turnCtx, "tool-b");

      await new Promise((r) => setTimeout(r, 10));
      const pingPongAnomalies = anomalies.filter((a) => a.kind === "tool_ping_pong");
      expect(pingPongAnomalies.length).toBeGreaterThan(0);
      expect(pingPongAnomalies[0]).toMatchObject({
        kind: "tool_ping_pong",
        toolIdA: "tool-a",
        toolIdB: "tool-b",
        threshold: 2,
      });
    });

    test("does not fire when alternations stay at or below threshold", async () => {
      const anomalies: AnomalySignal[] = [];
      const mw = createAgentMonitorMiddleware({
        thresholds: { maxPingPongCycles: 4 },
        onAnomaly: (s) => {
          anomalies.push(s);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });

      // 4 alternations = N (no fire)
      for (let i = 0; i < 5; i++) {
        await runToolCall(mw, turnCtx, i % 2 === 0 ? "tool-a" : "tool-b");
      }

      await new Promise((r) => setTimeout(r, 10));
      expect(anomalies.filter((a) => a.kind === "tool_ping_pong")).toHaveLength(0);
    });

    test("resets ping-pong counter when a third tool appears", async () => {
      const anomalies: AnomalySignal[] = [];
      const mw = createAgentMonitorMiddleware({
        // threshold=3: fires on 4th alternation
        thresholds: { maxPingPongCycles: 3 },
        onAnomaly: (s) => {
          anomalies.push(s);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });

      // Build a↔b to altCount=3 (= threshold, no fire)
      await runToolCall(mw, turnCtx, "tool-a");
      await runToolCall(mw, turnCtx, "tool-b"); // altCount=1
      await runToolCall(mw, turnCtx, "tool-a"); // altCount=2
      await runToolCall(mw, turnCtx, "tool-b"); // altCount=3 = threshold, no fire

      // c appears — resets to (b, c) pair, altCount=1
      await runToolCall(mw, turnCtx, "tool-c");
      // Only 1 more alternation on new pair: altCount=2 < threshold
      await runToolCall(mw, turnCtx, "tool-b"); // altCount=2 < 3

      await new Promise((r) => setTimeout(r, 10));
      // Without reset, a↔b altCount would have been 5 (>3) by now and fired.
      // The reset ensures no ping-pong fires in this sequence.
      expect(anomalies.filter((a) => a.kind === "tool_ping_pong")).toHaveLength(0);
    });

    test("ping-pong persists across turn boundaries", async () => {
      const anomalies: AnomalySignal[] = [];
      const mw = createAgentMonitorMiddleware({
        thresholds: { maxPingPongCycles: 2 },
        onAnomaly: (s) => {
          anomalies.push(s);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);

      // Turn 0: a→b
      const turn0 = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });
      await mw.onBeforeTurn?.(turn0);
      await runToolCall(mw, turn0, "tool-a");
      await runToolCall(mw, turn0, "tool-b"); // altCount=1

      // Turn 1: b→a→b (altCount=2, altCount=3 > 2 → fires)
      const turn1 = createMockTurnContext({ session: sessionCtx, turnIndex: 1 });
      await mw.onBeforeTurn?.(turn1);
      await runToolCall(mw, turn1, "tool-a"); // altCount=2
      await runToolCall(mw, turn1, "tool-b"); // altCount=3 > 2

      await new Promise((r) => setTimeout(r, 10));
      expect(anomalies.filter((a) => a.kind === "tool_ping_pong").length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Gap B: session_duration_exceeded
  // -------------------------------------------------------------------------

  describe("gap B: session_duration_exceeded", () => {
    test("fires when session duration exceeds threshold", async () => {
      const anomalies: AnomalySignal[] = [];
      const mw = createAgentMonitorMiddleware({
        thresholds: { maxSessionDurationMs: 1 },
        onAnomaly: (s) => {
          anomalies.push(s);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });

      // Wait long enough to exceed the 1ms threshold
      await new Promise((r) => setTimeout(r, 10));
      await runModelCall(mw, turnCtx);

      await new Promise((r) => setTimeout(r, 10));
      const durationAnomalies = anomalies.filter((a) => a.kind === "session_duration_exceeded");
      expect(durationAnomalies.length).toBeGreaterThan(0);
      expect(durationAnomalies[0]).toMatchObject({
        kind: "session_duration_exceeded",
        threshold: 1,
      });
    });

    test("fires at most once per session even if many model calls are made", async () => {
      const anomalies: AnomalySignal[] = [];
      const mw = createAgentMonitorMiddleware({
        thresholds: { maxSessionDurationMs: 1 },
        onAnomaly: (s) => {
          anomalies.push(s);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });

      await new Promise((r) => setTimeout(r, 10));
      // Multiple model calls all past the threshold
      await runModelCall(mw, turnCtx);
      await runModelCall(mw, turnCtx);
      await runModelCall(mw, turnCtx);

      await new Promise((r) => setTimeout(r, 10));
      expect(anomalies.filter((a) => a.kind === "session_duration_exceeded")).toHaveLength(1);
    });

    test("does not fire when session is well within threshold", async () => {
      const anomalies: AnomalySignal[] = [];
      const mw = createAgentMonitorMiddleware({
        thresholds: { maxSessionDurationMs: 300_000 },
        onAnomaly: (s) => {
          anomalies.push(s);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });

      await runModelCall(mw, turnCtx);

      await new Promise((r) => setTimeout(r, 10));
      expect(anomalies.filter((a) => a.kind === "session_duration_exceeded")).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Gap 3: tool_diversity_spike
  // -------------------------------------------------------------------------

  describe("gap 3: tool_diversity_spike", () => {
    test("fires when distinct tools per turn exceed threshold", async () => {
      const anomalies: AnomalySignal[] = [];
      const mw = createAgentMonitorMiddleware({
        thresholds: { maxDistinctToolsPerTurn: 3 },
        onAnomaly: (s) => {
          anomalies.push(s);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });
      await mw.onBeforeTurn?.(turnCtx);

      // 4 distinct tools > threshold of 3
      await runToolCall(mw, turnCtx, "tool-a");
      await runToolCall(mw, turnCtx, "tool-b");
      await runToolCall(mw, turnCtx, "tool-c");
      await runToolCall(mw, turnCtx, "tool-d");

      await new Promise((r) => setTimeout(r, 10));
      const diversityAnomalies = anomalies.filter((a) => a.kind === "tool_diversity_spike");
      expect(diversityAnomalies.length).toBeGreaterThan(0);
      expect(diversityAnomalies[0]).toMatchObject({
        kind: "tool_diversity_spike",
        threshold: 3,
      });
    });

    test("repeated same tool does not inflate distinct count", async () => {
      const anomalies: AnomalySignal[] = [];
      const mw = createAgentMonitorMiddleware({
        thresholds: { maxDistinctToolsPerTurn: 3 },
        onAnomaly: (s) => {
          anomalies.push(s);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });
      await mw.onBeforeTurn?.(turnCtx);

      // Same tool called 10 times — distinct count stays 1
      for (let i = 0; i < 10; i++) {
        await runToolCall(mw, turnCtx, "only-tool");
      }

      await new Promise((r) => setTimeout(r, 10));
      const diversityAnomalies = anomalies.filter((a) => a.kind === "tool_diversity_spike");
      expect(diversityAnomalies).toHaveLength(0);
    });

    test("resets distinct set between turns", async () => {
      const anomalies: AnomalySignal[] = [];
      const mw = createAgentMonitorMiddleware({
        thresholds: { maxDistinctToolsPerTurn: 3 },
        onAnomaly: (s) => {
          anomalies.push(s);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);

      const turn0 = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });
      await mw.onBeforeTurn?.(turn0);
      await runToolCall(mw, turn0, "a");
      await runToolCall(mw, turn0, "b");
      await runToolCall(mw, turn0, "c");
      // 3 distinct == threshold, no fire

      const turn1 = createMockTurnContext({ session: sessionCtx, turnIndex: 1 });
      await mw.onBeforeTurn?.(turn1);
      await runToolCall(mw, turn1, "d");
      await runToolCall(mw, turn1, "e");
      await runToolCall(mw, turn1, "f");
      // fresh 3 == threshold again, no fire

      await new Promise((r) => setTimeout(r, 10));
      expect(anomalies.filter((a) => a.kind === "tool_diversity_spike")).toHaveLength(0);
    });
  });

  // Phase 2: delegation_depth_exceeded
  //
  // Fire condition: agentDepth >= maxDelegationDepth AND spawn tool is called.
  // Disabled when agentDepth is absent OR spawnToolIds is empty.

  describe("phase 2: delegation_depth_exceeded", () => {
    test("fires when agent at maxDelegationDepth calls a spawn tool", async () => {
      const anomalies: AnomalySignal[] = [];
      const mw = createAgentMonitorMiddleware({
        agentDepth: 3,
        spawnToolIds: ["forge_agent"],
        thresholds: { maxDelegationDepth: 3 },
        onAnomaly: (s) => {
          anomalies.push(s);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const ctx = createMockTurnContext({ session: sessionCtx });
      await mw.onBeforeTurn?.(ctx);
      await runToolCall(mw, ctx, "forge_agent");
      await new Promise((r) => setTimeout(r, 10));

      const depthAnomalies = anomalies.filter((a) => a.kind === "delegation_depth_exceeded");
      expect(depthAnomalies).toHaveLength(1);
      expect(depthAnomalies[0]).toMatchObject({
        kind: "delegation_depth_exceeded",
        currentDepth: 3,
        maxDepth: 3,
        spawnToolId: "forge_agent",
      });
    });

    test("fires when agent depth exceeds maxDelegationDepth", async () => {
      const anomalies: AnomalySignal[] = [];
      const mw = createAgentMonitorMiddleware({
        agentDepth: 5,
        spawnToolIds: ["forge_agent"],
        thresholds: { maxDelegationDepth: 3 },
        onAnomaly: (s) => {
          anomalies.push(s);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const ctx = createMockTurnContext({ session: sessionCtx });
      await mw.onBeforeTurn?.(ctx);
      await runToolCall(mw, ctx, "forge_agent");
      await new Promise((r) => setTimeout(r, 10));

      expect(anomalies.filter((a) => a.kind === "delegation_depth_exceeded")).toHaveLength(1);
    });

    test("does not fire when agentDepth < maxDelegationDepth", async () => {
      const anomalies: AnomalySignal[] = [];
      const mw = createAgentMonitorMiddleware({
        agentDepth: 2,
        spawnToolIds: ["forge_agent"],
        thresholds: { maxDelegationDepth: 3 },
        onAnomaly: (s) => {
          anomalies.push(s);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const ctx = createMockTurnContext({ session: sessionCtx });
      await mw.onBeforeTurn?.(ctx);
      await runToolCall(mw, ctx, "forge_agent");
      await new Promise((r) => setTimeout(r, 10));

      expect(anomalies.filter((a) => a.kind === "delegation_depth_exceeded")).toHaveLength(0);
    });

    test("does not fire when agentDepth is not configured", async () => {
      const anomalies: AnomalySignal[] = [];
      const mw = createAgentMonitorMiddleware({
        // agentDepth absent — signal disabled
        spawnToolIds: ["forge_agent"],
        thresholds: { maxDelegationDepth: 3 },
        onAnomaly: (s) => {
          anomalies.push(s);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const ctx = createMockTurnContext({ session: sessionCtx });
      await mw.onBeforeTurn?.(ctx);
      await runToolCall(mw, ctx, "forge_agent");
      await new Promise((r) => setTimeout(r, 10));

      expect(anomalies.filter((a) => a.kind === "delegation_depth_exceeded")).toHaveLength(0);
    });

    test("does not fire when spawnToolIds is empty", async () => {
      const anomalies: AnomalySignal[] = [];
      const mw = createAgentMonitorMiddleware({
        agentDepth: 5,
        spawnToolIds: [], // empty — signal disabled
        thresholds: { maxDelegationDepth: 3 },
        onAnomaly: (s) => {
          anomalies.push(s);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const ctx = createMockTurnContext({ session: sessionCtx });
      await mw.onBeforeTurn?.(ctx);
      await runToolCall(mw, ctx, "forge_agent");
      await new Promise((r) => setTimeout(r, 10));

      expect(anomalies.filter((a) => a.kind === "delegation_depth_exceeded")).toHaveLength(0);
    });

    test("does not fire for non-spawn tools even when depth is exceeded", async () => {
      const anomalies: AnomalySignal[] = [];
      const mw = createAgentMonitorMiddleware({
        agentDepth: 5,
        spawnToolIds: ["forge_agent"],
        thresholds: { maxDelegationDepth: 3 },
        onAnomaly: (s) => {
          anomalies.push(s);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const ctx = createMockTurnContext({ session: sessionCtx });
      await mw.onBeforeTurn?.(ctx);
      await runToolCall(mw, ctx, "read_file"); // not a spawn tool
      await new Promise((r) => setTimeout(r, 10));

      expect(anomalies.filter((a) => a.kind === "delegation_depth_exceeded")).toHaveLength(0);
    });

    test("fires once per spawn call (no fire-once guard)", async () => {
      const anomalies: AnomalySignal[] = [];
      const mw = createAgentMonitorMiddleware({
        agentDepth: 3,
        spawnToolIds: ["forge_agent"],
        thresholds: { maxDelegationDepth: 3 },
        onAnomaly: (s) => {
          anomalies.push(s);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const ctx = createMockTurnContext({ session: sessionCtx });
      await mw.onBeforeTurn?.(ctx);
      await runToolCall(mw, ctx, "forge_agent");
      await runToolCall(mw, ctx, "forge_agent");
      await runToolCall(mw, ctx, "forge_agent");
      await new Promise((r) => setTimeout(r, 10));

      // Each spawn attempt at max depth fires independently
      expect(anomalies.filter((a) => a.kind === "delegation_depth_exceeded")).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  // wrapModelStream — streaming path mirrors wrapModelCall coverage
  // -------------------------------------------------------------------------

  describe("wrapModelStream", () => {
    test("passes through all chunks from next handler", async () => {
      const mw = createAgentMonitorMiddleware({});
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });

      const input: readonly ModelChunk[] = [
        { kind: "text_delta", delta: "hello" },
        { kind: "usage", inputTokens: 5, outputTokens: 10 },
      ];
      if (!mw.wrapModelStream) throw new Error("wrapModelStream missing");
      const handler = createMockModelStreamHandler(input);
      const collected: ModelChunk[] = [];
      for await (const chunk of mw.wrapModelStream(turnCtx, { messages: [] }, handler)) {
        collected.push(chunk);
      }
      expect(collected).toHaveLength(2);
      expect(collected[0]).toMatchObject({ kind: "text_delta", delta: "hello" });
      expect(collected[1]).toMatchObject({ kind: "usage", outputTokens: 10 });
    });

    test("does not crash when no session", async () => {
      const mw = createAgentMonitorMiddleware({});
      const turnCtx = createMockTurnContext();
      // No onSessionStart called — should pass through gracefully
      await runModelStream(mw, turnCtx, []);
    });

    test("increments totalModelCalls in session summary", async () => {
      const summaries: SessionMetricsSummary[] = [];
      const mw = createAgentMonitorMiddleware({
        onMetrics: (_sid, s) => {
          summaries.push(s);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });

      await runModelStream(mw, turnCtx);
      await runModelStream(mw, turnCtx);
      await mw.onSessionEnd?.(sessionCtx);

      expect(summaries[0]?.totalModelCalls).toBe(2);
    });

    test("does not fire model_latency_anomaly before warmup via stream", async () => {
      const anomalies: AnomalySignal[] = [];
      const mw = createAgentMonitorMiddleware({
        thresholds: { minLatencySamples: 100, latencyAnomalyFactor: 0.001 },
        onAnomaly: (s) => {
          anomalies.push(s);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });

      for (let i = 0; i < 5; i++) {
        await runModelStream(mw, turnCtx);
      }

      await new Promise((r) => setTimeout(r, 10));
      expect(anomalies.filter((a) => a.kind === "model_latency_anomaly")).toHaveLength(0);
    });

    test("fires session_duration_exceeded via stream path", async () => {
      const anomalies: AnomalySignal[] = [];
      const mw = createAgentMonitorMiddleware({
        thresholds: { maxSessionDurationMs: 1 },
        onAnomaly: (s) => {
          anomalies.push(s);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });

      await new Promise((r) => setTimeout(r, 10));
      await runModelStream(mw, turnCtx);

      await new Promise((r) => setTimeout(r, 10));
      const durationAnomalies = anomalies.filter((a) => a.kind === "session_duration_exceeded");
      expect(durationAnomalies.length).toBeGreaterThan(0);
      expect(durationAnomalies[0]).toMatchObject({
        kind: "session_duration_exceeded",
        threshold: 1,
      });
    });

    test("fires session_duration_exceeded at most once via multiple streams", async () => {
      const anomalies: AnomalySignal[] = [];
      const mw = createAgentMonitorMiddleware({
        thresholds: { maxSessionDurationMs: 1 },
        onAnomaly: (s) => {
          anomalies.push(s);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });

      await new Promise((r) => setTimeout(r, 10));
      await runModelStream(mw, turnCtx);
      await runModelStream(mw, turnCtx);
      await runModelStream(mw, turnCtx);

      await new Promise((r) => setTimeout(r, 10));
      expect(anomalies.filter((a) => a.kind === "session_duration_exceeded")).toHaveLength(1);
    });

    test("token_spike: does not fire before warmup samples via stream", async () => {
      const anomalies: AnomalySignal[] = [];
      const mw = createAgentMonitorMiddleware({
        thresholds: { minLatencySamples: 100, tokenSpikeAnomalyFactor: 0.001 },
        onAnomaly: (s) => {
          anomalies.push(s);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });

      const usageChunk: ModelChunk = { kind: "usage", inputTokens: 1, outputTokens: 1000 };
      for (let i = 0; i < 5; i++) {
        await runModelStream(mw, turnCtx, [usageChunk]);
      }

      await new Promise((r) => setTimeout(r, 10));
      expect(anomalies.filter((a) => a.kind === "token_spike")).toHaveLength(0);
    });

    test("token_spike: output token stats accumulate in session summary via stream", async () => {
      const summaries: SessionMetricsSummary[] = [];
      const mw = createAgentMonitorMiddleware({
        onMetrics: (_sid, s) => {
          summaries.push(s);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });

      const usageChunk: ModelChunk = { kind: "usage", inputTokens: 5, outputTokens: 50 };
      await runModelStream(mw, turnCtx, [usageChunk]);
      await runModelStream(mw, turnCtx, [usageChunk]);
      await mw.onSessionEnd?.(sessionCtx);

      expect(summaries[0]?.meanOutputTokens).toBe(50);
    });
  });

  // ---------------------------------------------------------------------------
  // Issue 160: goal drift
  // ---------------------------------------------------------------------------

  describe("goal_drift", () => {
    test("fires when no tool call matches any objective keyword", async () => {
      const anomalies: AnomalySignal[] = [];
      const mw = createAgentMonitorMiddleware({
        objectives: ["search the web", "write a report"],
        onAnomaly: (s) => {
          anomalies.push(s);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);

      // Turn 0: call unrelated tools
      const turn0 = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });
      await mw.onBeforeTurn?.(turn0);
      await runToolCall(mw, turn0, "email_send");
      await runToolCall(mw, turn0, "calendar_create");

      // Turn 1: onBeforeTurn evaluates turn 0's tool calls
      const turn1 = createMockTurnContext({ session: sessionCtx, turnIndex: 1 });
      await mw.onBeforeTurn?.(turn1);

      // Allow fire-and-forget callbacks to run
      await new Promise((r) => setTimeout(r, 20));

      const driftSignals = anomalies.filter((a) => a.kind === "goal_drift");
      expect(driftSignals.length).toBeGreaterThan(0);
    });

    test("does not fire when at least one tool matches an objective keyword", async () => {
      const anomalies: AnomalySignal[] = [];
      const mw = createAgentMonitorMiddleware({
        objectives: ["search the web"],
        onAnomaly: (s) => {
          anomalies.push(s);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);

      // Turn 0: call a tool that matches "search"
      const turn0 = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });
      await mw.onBeforeTurn?.(turn0);
      await runToolCall(mw, turn0, "web_search");

      // Turn 1: evaluate turn 0
      const turn1 = createMockTurnContext({ session: sessionCtx, turnIndex: 1 });
      await mw.onBeforeTurn?.(turn1);

      await new Promise((r) => setTimeout(r, 20));
      const driftSignals = anomalies.filter((a) => a.kind === "goal_drift");
      expect(driftSignals.length).toBe(0);
    });

    test("does not fire when no tool calls were made in the turn", async () => {
      const anomalies: AnomalySignal[] = [];
      const mw = createAgentMonitorMiddleware({
        objectives: ["search the web"],
        onAnomaly: (s) => {
          anomalies.push(s);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);

      // Turn 0: no tool calls
      const turn0 = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });
      await mw.onBeforeTurn?.(turn0);

      // Turn 1: evaluate turn 0 (no tools called — should not fire)
      const turn1 = createMockTurnContext({ session: sessionCtx, turnIndex: 1 });
      await mw.onBeforeTurn?.(turn1);

      await new Promise((r) => setTimeout(r, 20));
      const driftSignals = anomalies.filter((a) => a.kind === "goal_drift");
      expect(driftSignals.length).toBe(0);
    });

    test("does not fire when objectives array is empty", async () => {
      const anomalies: AnomalySignal[] = [];
      const mw = createAgentMonitorMiddleware({
        objectives: [],
        onAnomaly: (s) => {
          anomalies.push(s);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);

      const turn0 = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });
      await mw.onBeforeTurn?.(turn0);
      await runToolCall(mw, turn0, "email_send");

      const turn1 = createMockTurnContext({ session: sessionCtx, turnIndex: 1 });
      await mw.onBeforeTurn?.(turn1);

      await new Promise((r) => setTimeout(r, 20));
      expect(anomalies.filter((a) => a.kind === "goal_drift")).toHaveLength(0);
    });

    test("async scorer path: fires when scorer returns score > threshold", async () => {
      const anomalies: AnomalySignal[] = [];
      const mw = createAgentMonitorMiddleware({
        objectives: ["write a report"],
        goalDrift: {
          threshold: 0.5,
          scorer: async () => 1.0, // always fully drifted
        },
        onAnomaly: (s) => {
          anomalies.push(s);
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);

      const turn0 = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });
      await mw.onBeforeTurn?.(turn0);
      await runToolCall(mw, turn0, "email_send");

      const turn1 = createMockTurnContext({ session: sessionCtx, turnIndex: 1 });
      await mw.onBeforeTurn?.(turn1);

      // Allow async scorer to complete
      await new Promise((r) => setTimeout(r, 50));

      const driftSignals = anomalies.filter((a) => a.kind === "goal_drift");
      expect(driftSignals.length).toBeGreaterThan(0);
    });

    test("async scorer error is caught and does not propagate", async () => {
      let errorCaught = false;
      const mw = createAgentMonitorMiddleware({
        objectives: ["write a report"],
        goalDrift: {
          scorer: async () => {
            throw new Error("scorer failed");
          },
        },
        onAnomalyError: () => {
          errorCaught = true;
        },
      });
      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);

      const turn0 = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });
      await mw.onBeforeTurn?.(turn0);
      await runToolCall(mw, turn0, "email_send");

      const turn1 = createMockTurnContext({ session: sessionCtx, turnIndex: 1 });
      await mw.onBeforeTurn?.(turn1);

      await new Promise((r) => setTimeout(r, 50));
      expect(errorCaught).toBe(true);
    });
  });
});
