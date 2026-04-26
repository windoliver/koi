import { describe, expect, test } from "bun:test";
import type { AgentId, AnomalySignal, RiskAnalysis, SessionId } from "@koi/core";
import { createSecurityScorer } from "../scorer.js";

const SESSION = "s1" as SessionId;
const AGENT = "a1" as AgentId;
const BASE = { sessionId: SESSION, agentId: AGENT, timestamp: 0, turnIndex: 0 };

const CLEAN: RiskAnalysis = {
  riskLevel: "low",
  findings: [],
  rationale: "No patterns detected.",
};

const HIGH: RiskAnalysis = {
  riskLevel: "high",
  findings: [{ pattern: "DROP", description: "SQL injection", riskLevel: "high" }],
  rationale: "SQL injection found.",
};

const CRITICAL: RiskAnalysis = {
  riskLevel: "critical",
  findings: [{ pattern: "DROP", description: "SQL DDL", riskLevel: "critical" }],
  rationale: "Critical injection.",
};

const DENIED_ANOMALY: AnomalySignal = {
  ...BASE,
  kind: "denied_tool_calls",
  deniedCount: 3,
  threshold: 3,
};

const RATE_ANOMALY: AnomalySignal = {
  ...BASE,
  kind: "tool_rate_exceeded",
  callsPerTurn: 20,
  threshold: 20,
};

describe("createSecurityScorer", () => {
  const scorer = createSecurityScorer();

  test("score 0 for clean analysis and no anomalies", () => {
    const result = scorer.score(CLEAN, []);
    expect(result.score).toBe(0);
    expect(result.level).toBe("low");
  });

  test("score is higher for high-risk analysis than clean", () => {
    const clean = scorer.score(CLEAN, []);
    const high = scorer.score(HIGH, []);
    expect(high.score).toBeGreaterThan(clean.score);
  });

  test("critical analysis alone produces score in 'high' level range (50-74)", () => {
    const result = scorer.score(CRITICAL, []);
    // critical risk * 0.6 weight = 100 * 0.6 = 60 → high range
    expect(result.score).toBeGreaterThanOrEqual(50);
    expect(result.score).toBeLessThan(75);
    expect(result.level).toBe("high");
  });

  test("critical analysis with anomalies pushes score to critical level (>=75)", () => {
    const result = scorer.score(CRITICAL, [DENIED_ANOMALY, RATE_ANOMALY]);
    expect(result.score).toBeGreaterThanOrEqual(75);
    expect(result.level).toBe("critical");
  });

  test("score is clamped to [0, 100]", () => {
    const result = scorer.score(CRITICAL, [DENIED_ANOMALY, RATE_ANOMALY]);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  test("contributions include static_analysis entry", () => {
    const result = scorer.score(HIGH, []);
    const staticEntry = result.contributions.find((c) => c.source === "static_analysis");
    expect(staticEntry).toBeDefined();
    if (staticEntry !== undefined) {
      expect(staticEntry.riskLevel).toBe("high");
      expect(staticEntry.weight).toBeCloseTo(0.6);
    }
  });

  test("contributions include anomaly entry when anomalies present", () => {
    const result = scorer.score(CLEAN, [DENIED_ANOMALY]);
    const anomalyEntry = result.contributions.find((c) => c.source.startsWith("anomaly_"));
    expect(anomalyEntry).toBeDefined();
  });

  test("level mapping: score 0 = low", () => {
    const result = scorer.score(CLEAN, []);
    expect(result.level).toBe("low");
  });

  test("level mapping: score 50-74 = high (critical at 60 with 0.6 weight)", () => {
    const result = scorer.score(CRITICAL, []);
    expect(result.level).toBe("high");
  });

  test("contributions array has exactly 1 entry when no anomalies", () => {
    const result = scorer.score(HIGH, []);
    expect(result.contributions).toHaveLength(1);
    expect(result.contributions[0]?.source).toBe("static_analysis");
  });

  test("contributions array has 1+N entries with N anomalies", () => {
    const result = scorer.score(CLEAN, [DENIED_ANOMALY, RATE_ANOMALY]);
    expect(result.contributions).toHaveLength(3); // 1 static + 2 anomalies
  });

  test("anomalyToRiskLevel: irreversible_action_rate maps to critical", () => {
    const anomaly: AnomalySignal = {
      ...BASE,
      kind: "irreversible_action_rate",
      toolId: "rm_tool",
      callsThisTurn: 5,
      threshold: 3,
    };
    const result = scorer.score(CLEAN, [anomaly]);
    const entry = result.contributions.find((c) => c.source === "anomaly_irreversible_action_rate");
    expect(entry?.riskLevel).toBe("critical");
  });

  test("anomalyToRiskLevel: goal_drift maps to high", () => {
    const anomaly: AnomalySignal = {
      ...BASE,
      kind: "goal_drift",
      driftScore: 0.9,
      threshold: 0.5,
      objectives: ["write code"],
    };
    const result = scorer.score(CLEAN, [anomaly]);
    const entry = result.contributions.find((c) => c.source === "anomaly_goal_drift");
    expect(entry?.riskLevel).toBe("high");
  });

  test("anomalyToRiskLevel: delegation_depth_exceeded maps to high", () => {
    const anomaly: AnomalySignal = {
      ...BASE,
      kind: "delegation_depth_exceeded",
      currentDepth: 6,
      maxDepth: 5,
      spawnToolId: "spawn_agent",
    };
    const result = scorer.score(CLEAN, [anomaly]);
    const entry = result.contributions.find(
      (c) => c.source === "anomaly_delegation_depth_exceeded",
    );
    expect(entry?.riskLevel).toBe("high");
  });

  test("anomalyToRiskLevel: unknown kind falls through to medium (exhaustiveness guard)", () => {
    // Force the default branch by casting an unknown kind through the type system
    const anomaly = { ...BASE, kind: "unknown_future_kind" } as unknown as AnomalySignal;
    const result = scorer.score(CLEAN, [anomaly]);
    // The default branch returns "medium" and RISK_WEIGHTS.medium = 50, perAnomalyWeight = 0.4 → 20
    expect(result.score).toBe(20);
  });

  test("anomalyToRiskLevel: error_spike maps to medium", () => {
    const anomaly: AnomalySignal = {
      ...BASE,
      kind: "error_spike",
      errorCount: 5,
      threshold: 3,
    };
    const result = scorer.score(CLEAN, [anomaly]);
    const entry = result.contributions.find((c) => c.source === "anomaly_error_spike");
    expect(entry?.riskLevel).toBe("medium");
  });

  test("anomalyToRiskLevel: tool_repeated maps to medium", () => {
    const anomaly: AnomalySignal = {
      ...BASE,
      kind: "tool_repeated",
      toolId: "list_files",
      repeatCount: 6,
      threshold: 5,
    };
    const result = scorer.score(CLEAN, [anomaly]);
    const entry = result.contributions.find((c) => c.source === "anomaly_tool_repeated");
    expect(entry?.riskLevel).toBe("medium");
  });

  test("anomalyToRiskLevel: model_latency_anomaly maps to low", () => {
    const anomaly: AnomalySignal = {
      ...BASE,
      kind: "model_latency_anomaly",
      latencyMs: 5000,
      mean: 1000,
      stddev: 500,
      factor: 8,
    };
    const result = scorer.score(CLEAN, [anomaly]);
    const entry = result.contributions.find((c) => c.source === "anomaly_model_latency_anomaly");
    expect(entry?.riskLevel).toBe("low");
  });

  test("anomalyToRiskLevel: token_spike maps to medium", () => {
    const anomaly: AnomalySignal = {
      ...BASE,
      kind: "token_spike",
      outputTokens: 8000,
      mean: 2000,
      stddev: 500,
      factor: 12,
    };
    const result = scorer.score(CLEAN, [anomaly]);
    const entry = result.contributions.find((c) => c.source === "anomaly_token_spike");
    expect(entry?.riskLevel).toBe("medium");
  });

  test("anomalyToRiskLevel: tool_diversity_spike maps to medium", () => {
    const anomaly: AnomalySignal = {
      ...BASE,
      kind: "tool_diversity_spike",
      distinctToolCount: 15,
      threshold: 10,
    };
    const result = scorer.score(CLEAN, [anomaly]);
    const entry = result.contributions.find((c) => c.source === "anomaly_tool_diversity_spike");
    expect(entry?.riskLevel).toBe("medium");
  });

  test("anomalyToRiskLevel: tool_ping_pong maps to medium", () => {
    const anomaly: AnomalySignal = {
      ...BASE,
      kind: "tool_ping_pong",
      toolIdA: "read_file",
      toolIdB: "write_file",
      altCount: 8,
      threshold: 5,
    };
    const result = scorer.score(CLEAN, [anomaly]);
    const entry = result.contributions.find((c) => c.source === "anomaly_tool_ping_pong");
    expect(entry?.riskLevel).toBe("medium");
  });

  test("anomalyToRiskLevel: session_duration_exceeded maps to low", () => {
    const anomaly: AnomalySignal = {
      ...BASE,
      kind: "session_duration_exceeded",
      durationMs: 7200000,
      threshold: 3600000,
    };
    const result = scorer.score(CLEAN, [anomaly]);
    const entry = result.contributions.find(
      (c) => c.source === "anomaly_session_duration_exceeded",
    );
    expect(entry?.riskLevel).toBe("low");
  });

  test("level mapping: score 20-49 = medium (high analysis + only anomaly weight partial)", () => {
    // high risk (75) * 0.6 = 45 — should land in medium range (20-49)
    const result = scorer.score(HIGH, []);
    expect(result.score).toBeGreaterThanOrEqual(20);
    expect(result.score).toBeLessThan(50);
    expect(result.level).toBe("medium");
  });
});
