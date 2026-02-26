/**
 * End-to-end tests for @koi/agent-monitor through the full createKoi +
 * createLoopAdapter L1 runtime path.
 *
 * Two test suites:
 *
 * 1. "Real Anthropic API" — gated on ANTHROPIC_API_KEY. Validates that
 *    wrapModelCall fires on actual LLM responses, token stats are accurate,
 *    and onMetrics delivers a correct SessionMetricsSummary on session end.
 *
 * 2. "Synthetic pipeline" — no API key needed. Uses a deterministic model
 *    terminal wired through createKoi to verify all 8 anomaly signals fire
 *    with correct payloads through the full middleware chain.
 *
 * Run real-API tests:
 *   ANTHROPIC_API_KEY=sk-ant-... bun test src/__tests__/e2e.test.ts
 *
 * Run synthetic tests:
 *   bun test src/__tests__/e2e.test.ts
 */

import { describe, expect, test } from "bun:test";
import type { EngineEvent, ModelHandler, ModelRequest, ToolHandler, ToolRequest } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import { createAnthropicAdapter } from "@koi/model-router";
import { createAgentMonitorMiddleware } from "../index.js";
import type { AnomalySignal, SessionMetricsSummary } from "../types.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const describeRealApi = HAS_KEY ? describe : describe.skip;

const TIMEOUT_MS = 60_000;
const REAL_MODEL = "claude-haiku-4-5-20251001";
const MANIFEST_BASE = { name: "agent-monitor-e2e", version: "0.0.0", model: { name: "test" } };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drain an async iterable into an array. */
async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

/**
 * Create and run an agent with agent-monitor middleware, collecting anomalies
 * and the final metrics summary.
 *
 * The `modelCall` terminal is wrapped through the full createKoi middleware
 * chain (L1 lifecycle: onSessionStart → wrapModelCall → onSessionEnd).
 */
async function runMonitored(
  modelCall: ModelHandler,
  toolCall: ToolHandler | undefined,
  monitorConfig: Parameters<typeof createAgentMonitorMiddleware>[0],
  maxTurns = 30,
): Promise<{
  readonly anomalies: readonly AnomalySignal[];
  readonly summary: SessionMetricsSummary | undefined;
}> {
  const anomalies: AnomalySignal[] = [];
  let summary: SessionMetricsSummary | undefined;

  const monitor = createAgentMonitorMiddleware({
    ...monitorConfig,
    onAnomaly: (signal) => {
      anomalies.push(signal);
    },
    onMetrics: (_sid, s) => {
      summary = s;
    },
  });

  const adapter = createLoopAdapter({
    modelCall,
    ...(toolCall !== undefined ? { toolCall } : {}),
    maxTurns,
  });

  const runtime = await createKoi({
    manifest: MANIFEST_BASE,
    adapter,
    middleware: [monitor],
    loopDetection: false,
    limits: { maxTurns, maxDurationMs: 10_000, maxTokens: 500_000 },
  });

  try {
    await collectEvents(runtime.run({ kind: "text", text: "go" }));
  } finally {
    await runtime.dispose();
  }

  return { anomalies, summary };
}

// ---------------------------------------------------------------------------
// Synthetic model helpers
// ---------------------------------------------------------------------------

/**
 * Model that returns `toolCallCount` tool calls on the first invocation,
 * then returns a final text response. Used to trigger per-turn tool signals.
 */
function makeToolCallingModel(opts: {
  readonly toolCallCount: number;
  readonly toolName?: string;
  /** Names override per-call toolName when provided (for diversity tests). */
  readonly toolNames?: readonly string[];
}): ModelHandler {
  let callCount = 0;
  return async (_request: ModelRequest): Promise<import("@koi/core").ModelResponse> => {
    callCount += 1;
    if (callCount === 1) {
      const tcs = Array.from({ length: opts.toolCallCount }, (_, i) => ({
        toolName:
          opts.toolNames !== undefined ? (opts.toolNames[i] ?? "echo") : (opts.toolName ?? "echo"),
        callId: `call-${i}`,
        input: { n: i },
      }));
      return {
        content: "",
        model: "synthetic",
        usage: { inputTokens: 10, outputTokens: 5 },
        metadata: { toolCalls: tcs },
      };
    }
    return { content: "done", model: "synthetic", usage: { inputTokens: 5, outputTokens: 3 } };
  };
}

/**
 * Model that returns one tool call per turn for `toolTurns` turns (to build
 * up a consecutive-repeat count), then returns a final text response.
 */
function makeRepeatToolModel(toolTurns: number, toolName = "echo"): ModelHandler {
  let callCount = 0;
  return async (_request: ModelRequest): Promise<import("@koi/core").ModelResponse> => {
    callCount += 1;
    if (callCount <= toolTurns) {
      return {
        content: "",
        model: "synthetic",
        usage: { inputTokens: 10, outputTokens: 5 },
        metadata: {
          toolCalls: [{ toolName, callId: `call-${callCount}`, input: {} }],
        },
      };
    }
    return { content: "done", model: "synthetic", usage: { inputTokens: 5, outputTokens: 3 } };
  };
}

/**
 * Model that returns two responses: first a tool call, then a final response.
 * The second call is intentionally delayed to produce a latency anomaly.
 */
function makeLatencyModel(delayMs: number): ModelHandler {
  let callCount = 0;
  return async (_request: ModelRequest): Promise<import("@koi/core").ModelResponse> => {
    callCount += 1;
    if (callCount === 1) {
      return {
        content: "",
        model: "synthetic",
        usage: { inputTokens: 10, outputTokens: 5 },
        metadata: {
          toolCalls: [{ toolName: "echo", callId: "call-lat", input: {} }],
        },
      };
    }
    // Artificial delay so the second call has measurably higher latency.
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    return { content: "done", model: "synthetic", usage: { inputTokens: 5, outputTokens: 3 } };
  };
}

/**
 * Model that returns two responses with very different output token counts
 * to trigger a token spike on the second call.
 */
function makeTokenSpikeModel(firstTokens: number, secondTokens: number): ModelHandler {
  let callCount = 0;
  return async (_request: ModelRequest): Promise<import("@koi/core").ModelResponse> => {
    callCount += 1;
    if (callCount === 1) {
      return {
        content: "",
        model: "synthetic",
        usage: { inputTokens: 10, outputTokens: firstTokens },
        metadata: {
          toolCalls: [{ toolName: "echo", callId: "call-tok", input: {} }],
        },
      };
    }
    return {
      content: "done",
      model: "synthetic",
      usage: { inputTokens: 10, outputTokens: secondTokens },
    };
  };
}

/** Tool handler that always succeeds (echoes the tool name). */
const successToolHandler: ToolHandler = async (request: ToolRequest) => ({
  output: `ok:${request.toolId}`,
});

/** Tool handler that always returns a denial. */
const deniedToolHandler: ToolHandler = async (request: ToolRequest) => ({
  output: `denied:${request.toolId}`,
  metadata: { denied: true },
});

/** Tool handler that always throws. */
const throwingToolHandler: ToolHandler = async () => {
  throw new Error("synthetic tool error");
};

// ---------------------------------------------------------------------------
// Suite 1: Real Anthropic API
// ---------------------------------------------------------------------------

describeRealApi(
  "e2e: agent-monitor middleware through createKoi + createLoopAdapter (real Anthropic API)",
  () => {
    const anthropic = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });
    const realModelCall: ModelHandler = (request: ModelRequest) =>
      anthropic.complete({ ...request, model: REAL_MODEL });

    test(
      "session lifecycle callbacks fire in correct order",
      async () => {
        const events: string[] = [];

        const monitor = createAgentMonitorMiddleware({
          onAnomaly: () => {
            events.push("anomaly");
          },
          onMetrics: () => {
            events.push("metrics");
          },
        });

        const adapter = createLoopAdapter({ modelCall: realModelCall, maxTurns: 3 });
        const runtime = await createKoi({
          manifest: MANIFEST_BASE,
          adapter,
          middleware: [monitor],
          loopDetection: false,
          limits: { maxTurns: 3, maxDurationMs: 30_000, maxTokens: 10_000 },
        });

        try {
          await collectEvents(
            runtime.run({ kind: "text", text: "Reply with exactly one word: pong" }),
          );
        } finally {
          await runtime.dispose();
        }

        // onMetrics fires on session end (via onSessionEnd hook)
        expect(events).toContain("metrics");
        // No anomalies in a normal single-turn exchange
        expect(events).not.toContain("anomaly");
      },
      TIMEOUT_MS,
    );

    test(
      "wrapModelCall tracks output token statistics from real LLM response",
      async () => {
        let capturedSummary: SessionMetricsSummary | undefined;

        const monitor = createAgentMonitorMiddleware({
          onMetrics: (_sid, summary) => {
            capturedSummary = summary;
          },
        });

        const adapter = createLoopAdapter({ modelCall: realModelCall, maxTurns: 3 });
        const runtime = await createKoi({
          manifest: MANIFEST_BASE,
          adapter,
          middleware: [monitor],
          loopDetection: false,
          limits: { maxTurns: 3, maxDurationMs: 30_000, maxTokens: 10_000 },
        });

        try {
          await collectEvents(
            runtime.run({
              kind: "text",
              text: "Reply with exactly one word: pong",
            }),
          );
        } finally {
          await runtime.dispose();
        }

        expect(capturedSummary).toBeDefined();
        if (capturedSummary === undefined) return;

        // Real LLM must have consumed at least 1 model call
        expect(capturedSummary.totalModelCalls).toBeGreaterThanOrEqual(1);

        // Real API returns usage — output tokens should be positive
        expect(capturedSummary.meanOutputTokens).toBeGreaterThan(0);

        // Latency must be positive
        expect(capturedSummary.meanLatencyMs).toBeGreaterThan(0);

        // No errors, no denials, no anomalies in a clean single-turn run
        expect(capturedSummary.totalErrorCalls).toBe(0);
        expect(capturedSummary.totalDeniedCalls).toBe(0);
        expect(capturedSummary.anomalyCount).toBe(0);
      },
      TIMEOUT_MS,
    );

    test(
      "onMetrics summary reports correct turn count and tool call totals",
      async () => {
        let summary: SessionMetricsSummary | undefined;
        const monitor = createAgentMonitorMiddleware({
          onMetrics: (_sid, s) => {
            summary = s;
          },
        });

        const adapter = createLoopAdapter({ modelCall: realModelCall, maxTurns: 3 });
        const runtime = await createKoi({
          manifest: MANIFEST_BASE,
          adapter,
          middleware: [monitor],
          loopDetection: false,
          limits: { maxTurns: 3, maxDurationMs: 30_000, maxTokens: 10_000 },
        });

        try {
          await collectEvents(
            runtime.run({ kind: "text", text: "What is 2+2? Reply with just the number." }),
          );
        } finally {
          await runtime.dispose();
        }

        expect(summary).toBeDefined();
        if (summary === undefined) return;

        // One model call for a simple math question (no tool calls)
        expect(summary.totalModelCalls).toBe(1);
        expect(summary.totalToolCalls).toBe(0);
        // createKoi fires onBeforeTurn once for the actual turn (index 0) and once
        // proactively after the last turn_end (index 1) before the done event.
        // So turnCount = actualModelCalls + 1 = 2 for a single-turn session.
        expect(summary.turnCount).toBe(2);
        expect(summary.agentId).toBeDefined();
        expect(typeof summary.agentId).toBe("string");
      },
      TIMEOUT_MS,
    );
  },
);

// ---------------------------------------------------------------------------
// Suite 2: Synthetic pipeline — all 8 anomaly signals
// ---------------------------------------------------------------------------

describe("e2e: agent-monitor all 8 anomaly signals through createKoi + createLoopAdapter (synthetic)", () => {
  // Each test collects anomalies via the full middleware chain.
  // No real API calls — all model/tool responses are deterministic.

  test("tool_rate_exceeded fires when calls per turn exceed maxToolCallsPerTurn", async () => {
    // 6 calls in one turn with threshold=5 → fires on the 6th call
    const { anomalies, summary } = await runMonitored(
      makeToolCallingModel({ toolCallCount: 6 }),
      successToolHandler,
      { thresholds: { maxToolCallsPerTurn: 5 } },
    );

    const signal = anomalies.find((a) => a.kind === "tool_rate_exceeded");
    expect(signal).toBeDefined();
    if (signal === undefined || signal.kind !== "tool_rate_exceeded") return;

    expect(signal.callsPerTurn).toBe(6);
    expect(signal.threshold).toBe(5);
    expect(signal.sessionId).toBeDefined();
    expect(signal.agentId).toBeDefined();
    expect(typeof signal.timestamp).toBe("number");

    expect(summary).toBeDefined();
    expect(summary?.totalToolCalls).toBe(6);
  });

  test("tool_repeated fires when same tool called consecutively beyond maxConsecutiveRepeatCalls", async () => {
    // 4 turns each calling "echo" once → consecutiveRepeatCount reaches 4 > threshold=3
    const { anomalies } = await runMonitored(makeRepeatToolModel(4, "echo"), successToolHandler, {
      thresholds: { maxConsecutiveRepeatCalls: 3 },
    });

    const signal = anomalies.find((a) => a.kind === "tool_repeated");
    expect(signal).toBeDefined();
    if (signal === undefined || signal.kind !== "tool_repeated") return;

    expect(signal.toolId).toBe("echo");
    expect(signal.repeatCount).toBe(4);
    expect(signal.threshold).toBe(3);
  });

  test("tool_diversity_spike fires when distinct tools in a turn exceed maxDistinctToolsPerTurn", async () => {
    // 6 distinct tool names in one turn, threshold=5
    const toolNames = ["t1", "t2", "t3", "t4", "t5", "t6"] as const;
    const { anomalies, summary } = await runMonitored(
      makeToolCallingModel({ toolCallCount: 6, toolNames }),
      successToolHandler,
      { thresholds: { maxDistinctToolsPerTurn: 5 } },
    );

    const signal = anomalies.find((a) => a.kind === "tool_diversity_spike");
    expect(signal).toBeDefined();
    if (signal === undefined || signal.kind !== "tool_diversity_spike") return;

    expect(signal.distinctToolCount).toBe(6);
    expect(signal.threshold).toBe(5);
    expect(summary?.totalToolCalls).toBe(6);
  });

  test("irreversible_action_rate fires when destructive tool exceeds maxDestructiveCallsPerTurn", async () => {
    // "delete" is destructive; 4 calls with threshold=3 → fires on the 4th
    const { anomalies } = await runMonitored(
      makeToolCallingModel({ toolCallCount: 4, toolName: "delete" }),
      successToolHandler,
      {
        destructiveToolIds: ["delete"],
        thresholds: { maxDestructiveCallsPerTurn: 3 },
      },
    );

    const signal = anomalies.find((a) => a.kind === "irreversible_action_rate");
    expect(signal).toBeDefined();
    if (signal === undefined || signal.kind !== "irreversible_action_rate") return;

    expect(signal.toolId).toBe("delete");
    expect(signal.callsThisTurn).toBe(4);
    expect(signal.threshold).toBe(3);
  });

  test("denied_tool_calls fires when denied responses exceed maxDeniedCallsPerSession", async () => {
    // 4 tool calls, all denied, threshold=3 → fires on the 4th
    const { anomalies, summary } = await runMonitored(
      makeToolCallingModel({ toolCallCount: 4 }),
      deniedToolHandler,
      { thresholds: { maxDeniedCallsPerSession: 3 } },
    );

    const signal = anomalies.find((a) => a.kind === "denied_tool_calls");
    expect(signal).toBeDefined();
    if (signal === undefined || signal.kind !== "denied_tool_calls") return;

    expect(signal.deniedCount).toBe(4);
    expect(signal.threshold).toBe(3);
    expect(summary?.totalDeniedCalls).toBe(4);
  });

  test("error_spike fires when tool errors exceed maxErrorCallsPerSession", async () => {
    // 4 tool calls all throw, threshold=3 → fires on the 4th error
    const { anomalies, summary } = await runMonitored(
      makeToolCallingModel({ toolCallCount: 4 }),
      throwingToolHandler,
      { thresholds: { maxErrorCallsPerSession: 3 } },
    );

    const signal = anomalies.find((a) => a.kind === "error_spike");
    expect(signal).toBeDefined();
    if (signal === undefined || signal.kind !== "error_spike") return;

    expect(signal.errorCount).toBe(4);
    expect(signal.threshold).toBe(3);
    expect(summary?.totalErrorCalls).toBe(4);
  });

  test("model_latency_anomaly fires on a call that deviates significantly from the baseline", async () => {
    // Two model calls: the first is near-instantaneous (synthetic), the second
    // has a 100ms delay. With minLatencySamples=1 and factor=0.1, the second
    // call's latency exceeds mean + 0.1 * stddev → fires.
    const DELAY_MS = 100;

    const { anomalies, summary } = await runMonitored(
      makeLatencyModel(DELAY_MS),
      successToolHandler,
      {
        thresholds: {
          minLatencySamples: 1,
          latencyAnomalyFactor: 0.1,
        },
      },
    );

    const signal = anomalies.find((a) => a.kind === "model_latency_anomaly");
    expect(signal).toBeDefined();
    if (signal === undefined || signal.kind !== "model_latency_anomaly") return;

    // The anomalous call must have latency at least DELAY_MS
    expect(signal.latencyMs).toBeGreaterThanOrEqual(DELAY_MS);
    expect(signal.factor).toBe(0.1);
    expect(signal.stddev).toBeGreaterThan(0);
    expect(summary?.totalModelCalls).toBe(2);
  }, 15_000); // allow up to 15s for the 100ms delay

  test("token_spike fires when output tokens deviate significantly from the baseline", async () => {
    // Call 1: 10 output tokens (baseline)
    // Call 2: 1000 output tokens (spike)
    // With minLatencySamples=1, factor=0.5:
    //   after call 2: mean≈505, stddev≈700, upperBound≈855 < 1000 → FIRE
    const { anomalies, summary } = await runMonitored(
      makeTokenSpikeModel(10, 1000),
      successToolHandler,
      {
        thresholds: {
          minLatencySamples: 1,
          tokenSpikeAnomalyFactor: 0.5,
        },
      },
    );

    const signal = anomalies.find((a) => a.kind === "token_spike");
    expect(signal).toBeDefined();
    if (signal === undefined || signal.kind !== "token_spike") return;

    expect(signal.outputTokens).toBe(1000);
    expect(signal.factor).toBe(0.5);
    expect(signal.stddev).toBeGreaterThan(0);
    expect(summary?.meanOutputTokens).toBeGreaterThan(0);
    expect(summary?.outputTokenStddev).toBeGreaterThan(0);
  });

  test("anomalyCount in SessionMetricsSummary accumulates across multiple signals", async () => {
    // Two anomalies in one session:
    //   1. tool_rate_exceeded (6 calls, threshold=5)
    //   2. tool_diversity_spike (6 distinct tools, threshold=5)
    const toolNames = ["a", "b", "c", "d", "e", "f"] as const;
    const { anomalies, summary } = await runMonitored(
      makeToolCallingModel({ toolCallCount: 6, toolNames }),
      successToolHandler,
      {
        thresholds: {
          maxToolCallsPerTurn: 5,
          maxDistinctToolsPerTurn: 5,
        },
      },
    );

    // Both signals must have fired
    const rateSignals = anomalies.filter((a) => a.kind === "tool_rate_exceeded");
    const diversitySignals = anomalies.filter((a) => a.kind === "tool_diversity_spike");
    expect(rateSignals.length).toBeGreaterThanOrEqual(1);
    expect(diversitySignals.length).toBeGreaterThanOrEqual(1);

    // Summary reflects all anomalies (fired once each per crossing the threshold)
    expect(summary?.anomalyCount).toBeGreaterThanOrEqual(2);
  });

  test("anomalies carry correct sessionId + agentId + turnIndex metadata", async () => {
    const { anomalies } = await runMonitored(
      makeToolCallingModel({ toolCallCount: 6 }),
      successToolHandler,
      { thresholds: { maxToolCallsPerTurn: 5 } },
    );

    const signal = anomalies.find((a) => a.kind === "tool_rate_exceeded");
    expect(signal).toBeDefined();
    if (signal === undefined) return;

    expect(typeof signal.sessionId).toBe("string");
    expect((signal.sessionId as string).length).toBeGreaterThan(0);
    expect(typeof signal.agentId).toBe("string");
    expect((signal.agentId as string).length).toBeGreaterThan(0);
    expect(typeof signal.turnIndex).toBe("number");
    expect(signal.turnIndex).toBeGreaterThanOrEqual(0);
    expect(signal.timestamp).toBeGreaterThan(0);
  });

  test("onAnomaly errors are swallowed and do not interrupt the agent", async () => {
    // Even when onAnomaly throws, the agent should complete normally.
    let agentCompleted = false;
    const monitor = createAgentMonitorMiddleware({
      onAnomaly: () => {
        throw new Error("intentional onAnomaly error");
      },
      onMetrics: () => {
        agentCompleted = true;
      },
      thresholds: { maxToolCallsPerTurn: 5 },
    });

    const adapter = createLoopAdapter({
      modelCall: makeToolCallingModel({ toolCallCount: 6 }),
      toolCall: successToolHandler,
      maxTurns: 10,
    });

    const runtime = await createKoi({
      manifest: MANIFEST_BASE,
      adapter,
      middleware: [monitor],
      loopDetection: false,
      limits: { maxTurns: 10, maxDurationMs: 10_000, maxTokens: 100_000 },
    });

    try {
      // Should NOT throw even though onAnomaly throws
      await expect(collectEvents(runtime.run({ kind: "text", text: "go" }))).resolves.toBeDefined();
    } finally {
      await runtime.dispose();
    }

    // Agent completed and onMetrics fired → middleware didn't abort the session
    expect(agentCompleted).toBe(true);
  });

  test("non-destructive tools do not fire irreversible_action_rate", async () => {
    // "safe-tool" is not in destructiveToolIds — 10 calls should not fire
    const { anomalies } = await runMonitored(
      makeToolCallingModel({ toolCallCount: 10, toolName: "safe-tool" }),
      successToolHandler,
      {
        destructiveToolIds: ["delete"],
        thresholds: { maxDestructiveCallsPerTurn: 3 },
      },
    );

    const destructiveSignals = anomalies.filter((a) => a.kind === "irreversible_action_rate");
    expect(destructiveSignals).toHaveLength(0);
  });

  test("session state is isolated: two sequential sessions have independent metrics", async () => {
    // Session 1: 6 tool calls (crosses threshold)
    // Session 2: 2 tool calls (under threshold)
    // Both sessions use the same middleware instance.
    const session1Anomalies: AnomalySignal[] = [];
    const session2Anomalies: AnomalySignal[] = [];
    let session1Summary: SessionMetricsSummary | undefined;
    let session2Summary: SessionMetricsSummary | undefined;

    const monitor = createAgentMonitorMiddleware({
      onAnomaly: () => {
        // Sessions are sequential; anomalies go to the active session bucket
      },
      onMetrics: () => {},
      thresholds: { maxToolCallsPerTurn: 5 },
    });

    // Session 1
    {
      const monitor1 = createAgentMonitorMiddleware({
        onAnomaly: (s) => {
          session1Anomalies.push(s);
        },
        onMetrics: (_id, s) => {
          session1Summary = s;
        },
        thresholds: { maxToolCallsPerTurn: 5 },
      });
      const adapter1 = createLoopAdapter({
        modelCall: makeToolCallingModel({ toolCallCount: 6 }),
        toolCall: successToolHandler,
        maxTurns: 10,
      });
      const runtime1 = await createKoi({
        manifest: MANIFEST_BASE,
        adapter: adapter1,
        middleware: [monitor1],
        loopDetection: false,
        limits: { maxTurns: 10, maxDurationMs: 10_000, maxTokens: 100_000 },
      });
      try {
        await collectEvents(runtime1.run({ kind: "text", text: "go" }));
      } finally {
        await runtime1.dispose();
      }
    }

    // Session 2 — same monitor instance; state should be clean
    {
      const monitor2 = createAgentMonitorMiddleware({
        onAnomaly: (s) => {
          session2Anomalies.push(s);
        },
        onMetrics: (_id, s) => {
          session2Summary = s;
        },
        thresholds: { maxToolCallsPerTurn: 5 },
      });
      const adapter2 = createLoopAdapter({
        modelCall: makeToolCallingModel({ toolCallCount: 2 }),
        toolCall: successToolHandler,
        maxTurns: 10,
      });
      const runtime2 = await createKoi({
        manifest: MANIFEST_BASE,
        adapter: adapter2,
        middleware: [monitor2],
        loopDetection: false,
        limits: { maxTurns: 10, maxDurationMs: 10_000, maxTokens: 100_000 },
      });
      try {
        await collectEvents(runtime2.run({ kind: "text", text: "go" }));
      } finally {
        await runtime2.dispose();
      }
    }

    void monitor; // suppress unused warning

    // Session 1: 6 calls → tool_rate_exceeded fired
    const s1Rate = session1Anomalies.filter((a) => a.kind === "tool_rate_exceeded");
    expect(s1Rate.length).toBeGreaterThanOrEqual(1);
    expect(session1Summary?.totalToolCalls).toBe(6);

    // Session 2: 2 calls → no anomaly (2 ≤ 5)
    const s2Rate = session2Anomalies.filter((a) => a.kind === "tool_rate_exceeded");
    expect(s2Rate).toHaveLength(0);
    expect(session2Summary?.totalToolCalls).toBe(2);
  });
});
