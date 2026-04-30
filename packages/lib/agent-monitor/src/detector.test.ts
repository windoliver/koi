import { describe, expect, test } from "bun:test";
import type { AgentId, SessionId } from "@koi/core";
import { agentId, sessionId } from "@koi/core";
import { DEFAULT_THRESHOLDS } from "./config.js";
import * as detect from "./detector.js";
import { emptyStats, welfordUpdate } from "./latency.js";
import type { SessionMetrics } from "./types.js";

function freshMetrics(): SessionMetrics {
  return {
    sessionId: sessionId("s1") as SessionId,
    agentId: agentId("a1") as AgentId,
    startedAt: Date.now(),
    turnIndex: 0,
    turnsSeen: 0,
    totalToolCalls: 0,
    totalModelCalls: 0,
    totalErrorCalls: 0,
    totalDeniedCalls: 0,
    totalDestructiveCalls: 0,
    anomalyCount: 0,
    toolCallsThisTurn: 0,
    distinctToolsThisTurn: new Set(),
    destructiveThisTurn: new Map(),
    goalDriftMatchedThisTurn: false,
    toolIdsThisTurn: [],
    lastToolId: null,
    consecutiveRepeat: 0,
    prevToolId: null,
    pingPongAltCount: 0,
    latency: emptyStats(),
    outputTokens: emptyStats(),
  };
}

describe("detector", () => {
  test("tool_rate_exceeded: at threshold null, over fires", () => {
    const m = freshMetrics();
    m.toolCallsThisTurn = DEFAULT_THRESHOLDS.maxToolCallsPerTurn;
    expect(detect.detectToolRateExceeded(m, DEFAULT_THRESHOLDS)).toBeNull();
    m.toolCallsThisTurn = DEFAULT_THRESHOLDS.maxToolCallsPerTurn + 1;
    const s = detect.detectToolRateExceeded(m, DEFAULT_THRESHOLDS);
    expect(s?.kind).toBe("tool_rate_exceeded");
  });

  test("error_spike", () => {
    const m = freshMetrics();
    m.totalErrorCalls = DEFAULT_THRESHOLDS.maxErrorCallsPerSession;
    expect(detect.detectErrorSpike(m, DEFAULT_THRESHOLDS)).toBeNull();
    m.totalErrorCalls += 1;
    expect(detect.detectErrorSpike(m, DEFAULT_THRESHOLDS)?.kind).toBe("error_spike");
  });

  test("tool_repeated requires lastToolId set", () => {
    const m = freshMetrics();
    m.consecutiveRepeat = DEFAULT_THRESHOLDS.maxConsecutiveRepeatCalls + 1;
    expect(detect.detectToolRepeated(m, DEFAULT_THRESHOLDS)).toBeNull();
    m.lastToolId = "x";
    expect(detect.detectToolRepeated(m, DEFAULT_THRESHOLDS)?.kind).toBe("tool_repeated");
  });

  test("denied_tool_calls", () => {
    const m = freshMetrics();
    m.totalDeniedCalls = DEFAULT_THRESHOLDS.maxDeniedCallsPerSession;
    expect(detect.detectDeniedToolCalls(m, DEFAULT_THRESHOLDS)).toBeNull();
    m.totalDeniedCalls += 1;
    expect(detect.detectDeniedToolCalls(m, DEFAULT_THRESHOLDS)?.kind).toBe("denied_tool_calls");
  });

  test("irreversible_action_rate", () => {
    const m = freshMetrics();
    m.destructiveThisTurn.set("delete", DEFAULT_THRESHOLDS.maxDestructiveCallsPerTurn);
    expect(detect.detectIrreversibleActionRate(m, DEFAULT_THRESHOLDS, "delete")).toBeNull();
    m.destructiveThisTurn.set("delete", DEFAULT_THRESHOLDS.maxDestructiveCallsPerTurn + 1);
    expect(detect.detectIrreversibleActionRate(m, DEFAULT_THRESHOLDS, "delete")?.kind).toBe(
      "irreversible_action_rate",
    );
  });

  test("tool_diversity_spike", () => {
    const m = freshMetrics();
    for (let i = 0; i < DEFAULT_THRESHOLDS.maxDistinctToolsPerTurn; i++) {
      m.distinctToolsThisTurn.add(`t${i}`);
    }
    expect(detect.detectToolDiversitySpike(m, DEFAULT_THRESHOLDS)).toBeNull();
    m.distinctToolsThisTurn.add("extra");
    expect(detect.detectToolDiversitySpike(m, DEFAULT_THRESHOLDS)?.kind).toBe(
      "tool_diversity_spike",
    );
  });

  test("tool_ping_pong requires both toolIds and altCount > threshold", () => {
    const m = freshMetrics();
    m.lastToolId = "a";
    m.prevToolId = "b";
    m.pingPongAltCount = DEFAULT_THRESHOLDS.maxPingPongCycles;
    expect(detect.detectToolPingPong(m, DEFAULT_THRESHOLDS)).toBeNull();
    m.pingPongAltCount += 1;
    expect(detect.detectToolPingPong(m, DEFAULT_THRESHOLDS)?.kind).toBe("tool_ping_pong");
  });

  test("session_duration_exceeded", () => {
    const m = freshMetrics();
    const now = m.startedAt + DEFAULT_THRESHOLDS.maxSessionDurationMs + 1;
    expect(detect.detectSessionDurationExceeded(m, DEFAULT_THRESHOLDS, now)?.kind).toBe(
      "session_duration_exceeded",
    );
    expect(
      detect.detectSessionDurationExceeded(
        m,
        DEFAULT_THRESHOLDS,
        m.startedAt + DEFAULT_THRESHOLDS.maxSessionDurationMs,
      ),
    ).toBeNull();
  });

  test("delegation_depth_exceeded fires at depth >= max", () => {
    expect(
      detect.detectDelegationDepthExceeded(
        DEFAULT_THRESHOLDS.maxDelegationDepth - 1,
        DEFAULT_THRESHOLDS,
        "spawn",
      ),
    ).toBeNull();
    expect(
      detect.detectDelegationDepthExceeded(
        DEFAULT_THRESHOLDS.maxDelegationDepth,
        DEFAULT_THRESHOLDS,
        "spawn",
      )?.kind,
    ).toBe("delegation_depth_exceeded");
  });

  test("model_latency_anomaly: warm-up gating + outlier detection", () => {
    let stats = emptyStats();
    for (let i = 0; i < 4; i++) stats = welfordUpdate(stats, 100);
    expect(detect.detectModelLatencyAnomaly(1000, stats, DEFAULT_THRESHOLDS)).toBeNull();
    for (let i = 0; i < 1; i++) stats = welfordUpdate(stats, 100);
    expect(stats.count).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.minLatencySamples);
    // After 5 samples of 100ms, stddev = 0; threshold = mean + 0 = 100. 1000 > 100 → fires.
    expect(detect.detectModelLatencyAnomaly(1000, stats, DEFAULT_THRESHOLDS)?.kind).toBe(
      "model_latency_anomaly",
    );
  });

  test("token_spike", () => {
    let stats = emptyStats();
    for (let i = 0; i < 5; i++) stats = welfordUpdate(stats, 200);
    expect(detect.detectTokenSpike(2000, stats, DEFAULT_THRESHOLDS)?.kind).toBe("token_spike");
  });
});
