/**
 * ASI08 — Cascading Failures & Denial of Service rules.
 *
 * Checks for missing call limits, circuit breaker configuration, and budget
 * controls to prevent runaway agent loops and unbounded cost accumulation.
 */

import { getMetadataKey } from "../metadata.js";
import type { DoctorContext, DoctorFinding, DoctorRule } from "../types.js";

function checkNoCallLimits(ctx: DoctorContext): readonly DoctorFinding[] {
  if (ctx.middlewareNames().has("call-limits")) return [];
  return [
    {
      rule: "cascading-failures:no-call-limits",
      severity: "HIGH",
      category: "RESILIENCE",
      message:
        "No 'call-limits' middleware configured — agent may loop indefinitely without bounds",
      fix: "Add { name: 'call-limits' } to manifest.middleware",
      owasp: ["ASI08"],
      path: "middleware",
    },
  ];
}

function checkNoCircuitBreaker(ctx: DoctorContext): readonly DoctorFinding[] {
  if (ctx.delegation === undefined || !ctx.delegation.enabled) return [];
  const middleware = ctx.middlewareNames();
  if (middleware.has("circuit-breaker")) return [];

  // Also check metadata for circuit breaker config
  const cb = getMetadataKey(ctx.manifest.metadata, "circuitBreaker");
  if (cb !== undefined && cb !== null) return [];

  return [
    {
      rule: "cascading-failures:no-circuit-breaker",
      severity: "MEDIUM",
      category: "RESILIENCE",
      message:
        "Delegation is enabled but no circuit breaker is configured — cascading failures may propagate across agents",
      fix: "Add circuit breaker config to delegation or add 'circuit-breaker' middleware",
      owasp: ["ASI08"],
      path: "delegation",
    },
  ];
}

function checkNoBudgetLimits(ctx: DoctorContext): readonly DoctorFinding[] {
  const middleware = ctx.middlewareNames();
  if (middleware.has("budget") || middleware.has("pay")) return [];
  const maxCost = getMetadataKey(ctx.manifest.metadata, "maxCostUsd");
  if (maxCost !== undefined && maxCost !== null) return [];
  return [
    {
      rule: "cascading-failures:no-budget-limits",
      severity: "MEDIUM",
      category: "RESILIENCE",
      message:
        "No budget middleware or maxCostUsd configured — agent may incur unbounded model costs",
      fix: "Add { name: 'budget' } to manifest.middleware or set metadata.maxCostUsd",
      owasp: ["ASI08"],
      path: "middleware",
    },
  ];
}

export const cascadingFailuresRules: readonly DoctorRule[] = [
  {
    name: "cascading-failures:no-call-limits",
    category: "RESILIENCE",
    defaultSeverity: "HIGH",
    owasp: ["ASI08"],
    check: checkNoCallLimits,
  },
  {
    name: "cascading-failures:no-circuit-breaker",
    category: "RESILIENCE",
    defaultSeverity: "MEDIUM",
    owasp: ["ASI08"],
    check: checkNoCircuitBreaker,
  },
  {
    name: "cascading-failures:no-budget-limits",
    category: "RESILIENCE",
    defaultSeverity: "MEDIUM",
    owasp: ["ASI08"],
    check: checkNoBudgetLimits,
  },
];
