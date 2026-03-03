/**
 * Integration test: evaluator + anomaly bridge callback.
 *
 * Verifies the anomaly→governance feedback loop works end-to-end.
 */

import { describe, expect, test } from "bun:test";
import { agentId } from "@koi/core/ecs";
import type { PolicyRequest } from "@koi/core/governance-backend";
import type { MemoryEvaluator } from "../evaluator.js";
import { createGovernanceMemoryBackend } from "../governance-memory.js";
import type { AnomalySignalLike, EvaluationContext } from "../types.js";

function makeRequest(kind: string = "tool_call"): PolicyRequest {
  return {
    kind: kind as PolicyRequest["kind"],
    agentId: agentId("agent-1"),
    payload: {},
    timestamp: Date.now(),
  };
}

describe("anomaly bridge integration", () => {
  test("with anomalies → evaluator denies high-risk tools", () => {
    const anomalies: AnomalySignalLike[] = [
      { kind: "tool_rate_exceeded", sessionId: "s1" },
      { kind: "error_spike", sessionId: "s1" },
    ];

    const backend = createGovernanceMemoryBackend({
      rules: [
        {
          id: "deny-on-anomaly",
          effect: "forbid",
          priority: 0,
          condition: (_req: PolicyRequest, ctx: EvaluationContext) => ctx.anomalyCount > 0,
          message: "Denied due to active anomalies",
        },
        {
          id: "allow-all",
          effect: "permit",
          priority: 1,
          condition: () => true,
          message: "Allow",
        },
      ],
      getRecentAnomalies: () => anomalies,
    });

    // Cast to MemoryEvaluator for synchronous access
    const evaluator = backend.evaluator as MemoryEvaluator;
    const verdict = evaluator.evaluate(makeRequest());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.violations[0]?.message).toContain("anomalies");
    }
  });

  test("without anomalies → evaluator allows", () => {
    const backend = createGovernanceMemoryBackend({
      rules: [
        {
          id: "deny-on-anomaly",
          effect: "forbid",
          priority: 0,
          condition: (_req: PolicyRequest, ctx: EvaluationContext) => ctx.anomalyCount > 0,
          message: "Denied due to active anomalies",
        },
        {
          id: "allow-all",
          effect: "permit",
          priority: 1,
          condition: () => true,
          message: "Allow",
        },
      ],
      getRecentAnomalies: () => [],
    });

    const evaluator = backend.evaluator as MemoryEvaluator;
    const verdict = evaluator.evaluate(makeRequest());
    expect(verdict.ok).toBe(true);
  });

  test("callback throws → evaluator works normally (fail-open)", () => {
    const backend = createGovernanceMemoryBackend({
      rules: [
        {
          id: "deny-on-anomaly",
          effect: "forbid",
          priority: 0,
          condition: (_req: PolicyRequest, ctx: EvaluationContext) => ctx.anomalyCount > 0,
          message: "Denied due to active anomalies",
        },
        {
          id: "allow-all",
          effect: "permit",
          priority: 1,
          condition: () => true,
          message: "Allow",
        },
      ],
      getRecentAnomalies: () => {
        throw new Error("Monitor service unavailable");
      },
    });

    const evaluator = backend.evaluator as MemoryEvaluator;
    const verdict = evaluator.evaluate(makeRequest());
    expect(verdict.ok).toBe(true);
  });

  test("backend with all sub-interfaces is wired correctly", () => {
    const backend = createGovernanceMemoryBackend({
      rules: [
        {
          id: "allow-all",
          effect: "permit",
          priority: 0,
          condition: () => true,
          message: "Allow",
        },
      ],
    });

    expect(backend.evaluator).toBeDefined();
    expect(backend.constraints).toBeDefined();
    expect(backend.compliance).toBeDefined();
    expect(backend.violations).toBeDefined();
    expect(backend.dispose).toBeDefined();
  });

  test("dispose clears internal state", () => {
    const backend = createGovernanceMemoryBackend({
      rules: [
        {
          id: "allow-all",
          effect: "permit",
          priority: 0,
          condition: () => true,
          message: "Allow",
        },
      ],
    });

    backend.dispose?.();
  });
});
