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
});
