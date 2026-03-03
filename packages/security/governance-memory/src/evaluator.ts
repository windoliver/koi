/**
 * In-memory policy evaluator — constraint DAG + anomaly bridge + adaptive thresholds.
 *
 * Evaluation flow:
 * 1. Filter rules by scope (skip non-matching request kinds)
 * 2. Fetch anomaly context (fail-open: catch errors, return empty)
 * 3. Build EvaluationContext with anomalies + adaptive thresholds
 * 4. Iterate topologically-sorted rules:
 *    - Skip if dependencies not satisfied
 *    - Evaluate condition against request + context
 *    - First forbid match → short-circuit deny
 *    - Permit match → mark allowed, continue checking forbids
 * 5. No permit matched → default-deny
 * 6. Update adaptive thresholds on result
 */

import type {
  GovernanceVerdict,
  PolicyEvaluator,
  PolicyRequest,
  Violation,
  ViolationSeverity,
} from "@koi/core/governance-backend";
import { GOVERNANCE_ALLOW } from "@koi/core/governance-backend";
import {
  type AdaptiveThreshold,
  adjustThreshold,
  createAdaptiveThreshold,
} from "./adaptive-threshold.js";
import { createConstraintDag } from "./dag.js";
import type {
  AnomalySignalLike,
  EvaluationContext,
  GovernanceMemoryConfig,
  GovernanceRule,
} from "./types.js";

// ---------------------------------------------------------------------------
// MemoryEvaluator — the internal evaluator with adaptive state
// ---------------------------------------------------------------------------

/** Extended PolicyEvaluator with synchronous evaluate and adaptive threshold access. */
export interface MemoryEvaluator extends PolicyEvaluator {
  /** Synchronous policy evaluation (narrows the base contract's return type). */
  readonly evaluate: (request: PolicyRequest) => GovernanceVerdict;
  /** Read-only snapshot of current adaptive threshold values. */
  readonly getThresholds: () => ReadonlyMap<string, number>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create an in-memory policy evaluator from configuration. */
export function createMemoryEvaluator(config: GovernanceMemoryConfig): MemoryEvaluator {
  const rules = config.rules ?? [];
  const dag = createConstraintDag(rules);
  const elevateKinds = new Set(config.elevateOnAnomalyKinds ?? []);

  // Initialize adaptive thresholds from config.
  // Map is mutated internally as encapsulated mutable state (same pattern as RingBuffer).
  // Not exposed outside the factory closure.
  const thresholds = new Map<string, AdaptiveThreshold>();
  if (config.adaptiveThresholds !== undefined) {
    for (const [ruleId, thresholdConfig] of config.adaptiveThresholds) {
      thresholds.set(ruleId, createAdaptiveThreshold(thresholdConfig));
    }
  }

  function getThresholdValues(): ReadonlyMap<string, number> {
    const result = new Map<string, number>();
    for (const [id, t] of thresholds) {
      result.set(id, t.currentValue);
    }
    return result;
  }

  function fetchAnomalies(request: PolicyRequest): readonly AnomalySignalLike[] {
    if (config.getRecentAnomalies === undefined) return [];
    try {
      // Use agentId as sessionId proxy — callers bind appropriately
      return config.getRecentAnomalies(request.agentId);
    } catch (_e: unknown) {
      // Fail-open: anomaly bridge errors must not block governance
      return [];
    }
  }

  function buildContext(anomalies: readonly AnomalySignalLike[]): EvaluationContext {
    return {
      anomalyCount: anomalies.length,
      recentAnomalies: anomalies,
      adaptiveThresholds: getThresholdValues(),
    };
  }

  function effectiveSeverity(
    rule: GovernanceRule,
    anomalies: readonly AnomalySignalLike[],
  ): ViolationSeverity {
    const base = rule.severity ?? (rule.effect === "forbid" ? "critical" : "info");
    // Elevate severity when relevant anomalies are present
    if (base !== "critical" && anomalies.some((a) => elevateKinds.has(a.kind))) {
      return "critical";
    }
    return base;
  }

  function evaluate(request: PolicyRequest): GovernanceVerdict {
    // Empty DAG → default-deny (no permits = deny)
    if (dag.sortedRules.length === 0) {
      return {
        ok: false,
        violations: [
          {
            rule: "__default_deny",
            severity: "critical",
            message: "No governance rules configured — default deny",
          },
        ],
      };
    }

    const anomalies = fetchAnomalies(request);
    const context = buildContext(anomalies);

    const satisfiedRules = new Set<string>();
    // let: tracks whether any permit rule matched during evaluation
    let permitted = false;

    for (const rule of dag.sortedRules) {
      // Skip rules not matching this request kind
      if (rule.scope !== undefined && !rule.scope.includes(request.kind)) {
        // Non-matching scope rules are treated as satisfied for dependency purposes
        satisfiedRules.add(rule.id);
        continue;
      }

      // Skip if dependencies not satisfied
      const deps = dag.dependencyMap.get(rule.id) ?? [];
      const depsOk = deps.every((d) => satisfiedRules.has(d));
      if (!depsOk) continue;

      const matches = rule.condition(request, context);

      if (matches && rule.effect === "forbid") {
        // Short-circuit: first forbid match → deny
        const severity = effectiveSeverity(rule, anomalies);
        const violation: Violation = {
          rule: rule.id,
          severity,
          message: rule.message,
        };

        // Tighten adaptive threshold for this rule
        updateThreshold(thresholds, rule.id, true);

        return { ok: false, violations: [violation] };
      }

      if (matches && rule.effect === "permit") {
        permitted = true;
      }

      // Rule evaluated successfully (whether matched or not) → mark satisfied
      satisfiedRules.add(rule.id);
    }

    if (!permitted) {
      // No permit matched → default-deny
      return {
        ok: false,
        violations: [
          {
            rule: "__default_deny",
            severity: "critical",
            message: "No permit rule matched — default deny",
          },
        ],
      };
    }

    // Allowed — relax adaptive thresholds for rules that didn't fire
    for (const rule of dag.sortedRules) {
      updateThreshold(thresholds, rule.id, false);
    }

    return GOVERNANCE_ALLOW;
  }

  return {
    evaluate,
    getThresholds: getThresholdValues,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function updateThreshold(
  thresholds: Map<string, AdaptiveThreshold>,
  ruleId: string,
  violated: boolean,
): void {
  const current = thresholds.get(ruleId);
  if (current !== undefined) {
    thresholds.set(ruleId, adjustThreshold(current, violated));
  }
}
