/**
 * ASI08 — Cascading Failures & Denial of Service rules.
 *
 * Checks for missing call limits and circuit breaker configuration
 * to prevent runaway agent loops and cascading failures.
 */

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
  const metadata = ctx.manifest.metadata;
  if (metadata !== undefined) {
    const cb = metadata.circuitBreaker;
    if (cb !== undefined && cb !== null) return [];
  }

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
];
