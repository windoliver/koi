/**
 * ASI06 — Memory Poisoning rules.
 *
 * Checks for memory subsystem risks — using memory without input
 * sanitization, and missing context size limits.
 */

import type { DoctorContext, DoctorFinding, DoctorRule } from "../types.js";

function checkMemoryWithoutSanitize(ctx: DoctorContext): readonly DoctorFinding[] {
  const middleware = ctx.middlewareNames();
  if (!middleware.has("memory")) return [];
  if (middleware.has("sanitize")) return [];
  return [
    {
      rule: "memory-poisoning:memory-without-sanitize",
      severity: "HIGH",
      category: "RESILIENCE",
      message:
        "'memory' middleware is configured without 'sanitize' — stored memories may contain injected content",
      fix: "Add { name: 'sanitize' } to manifest.middleware before 'memory'",
      owasp: ["ASI06"],
      path: "middleware",
    },
  ];
}

function checkNoContextLimits(ctx: DoctorContext): readonly DoctorFinding[] {
  const middleware = ctx.middlewareNames();
  if (middleware.has("compactor") || middleware.has("context-editing")) return [];
  return [
    {
      rule: "memory-poisoning:no-context-limits",
      severity: "MEDIUM",
      category: "RESILIENCE",
      message: "No 'compactor' or 'context-editing' middleware — context window may grow unbounded",
      fix: "Add { name: 'compactor' } to manifest.middleware to manage context size",
      owasp: ["ASI06"],
      path: "middleware",
    },
  ];
}

export const memoryPoisoningRules: readonly DoctorRule[] = [
  {
    name: "memory-poisoning:memory-without-sanitize",
    category: "RESILIENCE",
    defaultSeverity: "HIGH",
    owasp: ["ASI06"],
    check: checkMemoryWithoutSanitize,
  },
  {
    name: "memory-poisoning:no-context-limits",
    category: "RESILIENCE",
    defaultSeverity: "MEDIUM",
    owasp: ["ASI06"],
    check: checkNoContextLimits,
  },
];
