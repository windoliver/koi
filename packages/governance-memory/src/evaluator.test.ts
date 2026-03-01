/**
 * Tests for the in-memory policy evaluator.
 */

import { describe, expect, test } from "bun:test";
import { agentId } from "@koi/core/ecs";
import type { PolicyRequest } from "@koi/core/governance-backend";
import { GOVERNANCE_ALLOW } from "@koi/core/governance-backend";
import { createMemoryEvaluator } from "./evaluator.js";
import type { AnomalySignalLike, EvaluationContext, GovernanceRule } from "./types.js";

function makeRequest(kind: string = "tool_call"): PolicyRequest {
  return {
    kind: kind as PolicyRequest["kind"],
    agentId: agentId("agent-1"),
    payload: {},
    timestamp: Date.now(),
  };
}

function makeRule(overrides: Partial<GovernanceRule> & { readonly id: string }): GovernanceRule {
  return {
    effect: "permit",
    priority: 0,
    condition: () => true,
    message: `Rule ${overrides.id}`,
    ...overrides,
  };
}

describe("createMemoryEvaluator", () => {
  test("empty rules → default-deny", () => {
    const evaluator = createMemoryEvaluator({});
    const verdict = evaluator.evaluate(makeRequest());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.violations[0]?.rule).toBe("__default_deny");
    }
  });

  test("single permit rule → allows matching requests", () => {
    const evaluator = createMemoryEvaluator({
      rules: [makeRule({ id: "allow-all", effect: "permit" })],
    });
    const verdict = evaluator.evaluate(makeRequest());
    expect(verdict.ok).toBe(true);
  });

  test("single forbid rule → denies matching requests", () => {
    const evaluator = createMemoryEvaluator({
      rules: [
        makeRule({ id: "allow-base", effect: "permit", priority: 10 }),
        makeRule({ id: "deny-all", effect: "forbid", priority: 0 }),
      ],
    });
    const verdict = evaluator.evaluate(makeRequest());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.violations[0]?.rule).toBe("deny-all");
    }
  });

  test("forbid wins over permit at same priority (forbid evaluated first by position)", () => {
    const evaluator = createMemoryEvaluator({
      rules: [
        makeRule({ id: "deny", effect: "forbid", priority: 0 }),
        makeRule({ id: "allow", effect: "permit", priority: 0 }),
      ],
    });
    const verdict = evaluator.evaluate(makeRequest());
    expect(verdict.ok).toBe(false);
  });

  test("permit at lower priority evaluated before forbid at higher priority", () => {
    const evaluator = createMemoryEvaluator({
      rules: [
        makeRule({ id: "allow", effect: "permit", priority: 0 }),
        makeRule({
          id: "deny",
          effect: "forbid",
          priority: 10,
          condition: () => false,
        }),
      ],
    });
    const verdict = evaluator.evaluate(makeRequest());
    expect(verdict.ok).toBe(true);
  });

  test("scope filtering — rule with scope not matching request kind is skipped", () => {
    const evaluator = createMemoryEvaluator({
      rules: [
        makeRule({
          id: "deny-spawn",
          effect: "forbid",
          priority: 0,
          scope: ["spawn"],
        }),
        makeRule({ id: "allow-all", effect: "permit", priority: 1 }),
      ],
    });
    const verdict = evaluator.evaluate(makeRequest("tool_call"));
    expect(verdict.ok).toBe(true);
  });

  test("scope filtering — rule with matching scope fires", () => {
    const evaluator = createMemoryEvaluator({
      rules: [
        makeRule({
          id: "deny-tools",
          effect: "forbid",
          priority: 0,
          scope: ["tool_call"],
        }),
        makeRule({ id: "allow-all", effect: "permit", priority: 1 }),
      ],
    });
    const verdict = evaluator.evaluate(makeRequest("tool_call"));
    expect(verdict.ok).toBe(false);
  });

  test("no permit matched → default-deny", () => {
    const evaluator = createMemoryEvaluator({
      rules: [
        makeRule({
          id: "allow-spawn",
          effect: "permit",
          priority: 0,
          scope: ["spawn"],
        }),
      ],
    });
    const verdict = evaluator.evaluate(makeRequest("tool_call"));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.violations[0]?.rule).toBe("__default_deny");
    }
  });

  test("GOVERNANCE_ALLOW singleton used when allowed", () => {
    const evaluator = createMemoryEvaluator({
      rules: [makeRule({ id: "allow-all", effect: "permit" })],
    });
    const verdict = evaluator.evaluate(makeRequest());
    expect(verdict).toBe(GOVERNANCE_ALLOW);
  });

  test("short-circuit — first forbid match stops evaluation", () => {
    // let: track whether second forbid was reached
    let secondForbidCalled = false;
    const evaluator = createMemoryEvaluator({
      rules: [
        makeRule({ id: "deny-1", effect: "forbid", priority: 0 }),
        makeRule({
          id: "deny-2",
          effect: "forbid",
          priority: 1,
          condition: () => {
            secondForbidCalled = true;
            return true;
          },
        }),
        makeRule({ id: "allow", effect: "permit", priority: 2 }),
      ],
    });
    evaluator.evaluate(makeRequest());
    expect(secondForbidCalled).toBe(false);
  });

  test("dependency chain — child fires when parent evaluated", () => {
    const evaluator = createMemoryEvaluator({
      rules: [
        makeRule({
          id: "parent",
          effect: "permit",
          priority: 0,
          condition: () => false,
        }),
        makeRule({
          id: "child-deny",
          effect: "forbid",
          priority: 1,
          dependsOn: ["parent"],
        }),
        makeRule({ id: "fallback-allow", effect: "permit", priority: 2 }),
      ],
    });
    // Parent was evaluated (satisfied) even though condition was false
    // → child-deny fires → deny
    const verdict = evaluator.evaluate(makeRequest());
    expect(verdict.ok).toBe(false);
  });

  describe("anomaly bridge", () => {
    test("with anomalies → context enriched", () => {
      // let: track context passed to rule
      let capturedContext: EvaluationContext | undefined;
      const anomalies: readonly AnomalySignalLike[] = [
        { kind: "tool_rate_exceeded", sessionId: "s1" },
        { kind: "error_spike", sessionId: "s1" },
      ];

      const evaluator = createMemoryEvaluator({
        rules: [
          makeRule({
            id: "check-context",
            effect: "permit",
            condition: (_req, ctx) => {
              capturedContext = ctx;
              return true;
            },
          }),
        ],
        getRecentAnomalies: () => anomalies,
      });

      evaluator.evaluate(makeRequest());
      expect(capturedContext?.anomalyCount).toBe(2);
      expect(capturedContext?.recentAnomalies).toHaveLength(2);
    });

    test("without anomalies → context empty", () => {
      // let: track context
      let capturedContext: EvaluationContext | undefined;

      const evaluator = createMemoryEvaluator({
        rules: [
          makeRule({
            id: "check-context",
            effect: "permit",
            condition: (_req, ctx) => {
              capturedContext = ctx;
              return true;
            },
          }),
        ],
      });

      evaluator.evaluate(makeRequest());
      expect(capturedContext?.anomalyCount).toBe(0);
      expect(capturedContext?.recentAnomalies).toHaveLength(0);
    });

    test("callback throws → evaluator still works (fail-open)", () => {
      const evaluator = createMemoryEvaluator({
        rules: [makeRule({ id: "allow-all", effect: "permit" })],
        getRecentAnomalies: () => {
          throw new Error("Monitor down");
        },
      });
      const verdict = evaluator.evaluate(makeRequest());
      expect(verdict.ok).toBe(true);
    });
  });

  describe("severity elevation", () => {
    test("anomaly kind in elevateOnAnomalyKinds → severity elevated to critical", () => {
      const evaluator = createMemoryEvaluator({
        rules: [
          makeRule({
            id: "soft-deny",
            effect: "forbid",
            priority: 0,
            severity: "warning",
          }),
          makeRule({ id: "allow", effect: "permit", priority: 1 }),
        ],
        getRecentAnomalies: () => [{ kind: "error_spike", sessionId: "s1" }],
        elevateOnAnomalyKinds: ["error_spike"],
      });

      const verdict = evaluator.evaluate(makeRequest());
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) {
        expect(verdict.violations[0]?.severity).toBe("critical");
      }
    });
  });

  describe("adaptive thresholds", () => {
    test("thresholds available in evaluation context", () => {
      // let: track context
      let capturedContext: EvaluationContext | undefined;

      const evaluator = createMemoryEvaluator({
        rules: [
          makeRule({
            id: "threshold-rule",
            effect: "permit",
            condition: (_req, ctx) => {
              capturedContext = ctx;
              return true;
            },
          }),
        ],
        adaptiveThresholds: new Map([
          [
            "threshold-rule",
            { baseValue: 100, decayRate: 0.9, recoveryRate: 1.02, floor: 10, ceiling: 200 },
          ],
        ]),
      });

      evaluator.evaluate(makeRequest());
      expect(capturedContext?.adaptiveThresholds.get("threshold-rule")).toBe(100);
    });

    test("threshold decays after violation", () => {
      const evaluator = createMemoryEvaluator({
        rules: [
          makeRule({ id: "deny-rule", effect: "forbid", priority: 0 }),
          makeRule({ id: "allow", effect: "permit", priority: 1 }),
        ],
        adaptiveThresholds: new Map([
          [
            "deny-rule",
            { baseValue: 100, decayRate: 0.9, recoveryRate: 1.02, floor: 10, ceiling: 200 },
          ],
        ]),
      });

      evaluator.evaluate(makeRequest());
      const thresholds = evaluator.getThresholds();
      expect(thresholds.get("deny-rule")).toBe(90);
    });

    test("threshold recovers after clean eval", () => {
      const evaluator = createMemoryEvaluator({
        rules: [makeRule({ id: "allow", effect: "permit", priority: 0 })],
        adaptiveThresholds: new Map([
          [
            "allow",
            { baseValue: 100, decayRate: 0.9, recoveryRate: 1.02, floor: 10, ceiling: 200 },
          ],
        ]),
      });

      evaluator.evaluate(makeRequest());
      const thresholds = evaluator.getThresholds();
      expect(thresholds.get("allow")).toBe(102);
    });
  });
});
