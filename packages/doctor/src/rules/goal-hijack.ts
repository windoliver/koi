/**
 * ASI01 — Agentic Goal Hijacking rules.
 *
 * Checks for missing defenses against prompt injection
 * and goal manipulation attacks.
 */

import type { DoctorContext, DoctorFinding, DoctorRule } from "../types.js";

function checkMissingSanitizeMiddleware(ctx: DoctorContext): readonly DoctorFinding[] {
  const names = ctx.middlewareNames();
  if (names.has("sanitize")) return [];
  return [
    {
      rule: "goal-hijack:missing-sanitize-middleware",
      severity: "HIGH",
      category: "GOAL_INTEGRITY",
      message:
        "No 'sanitize' middleware configured — agent input is not scrubbed for injection attacks",
      fix: "Add { name: 'sanitize' } to manifest.middleware",
      owasp: ["ASI01"],
      path: "middleware",
    },
  ];
}

function checkMissingGuardrailsMiddleware(ctx: DoctorContext): readonly DoctorFinding[] {
  const names = ctx.middlewareNames();
  if (names.has("guardrails")) return [];
  return [
    {
      rule: "goal-hijack:missing-guardrails-middleware",
      severity: "MEDIUM",
      category: "GOAL_INTEGRITY",
      message:
        "No 'guardrails' middleware configured — agent output is not validated against constraints",
      fix: "Add { name: 'guardrails' } to manifest.middleware",
      owasp: ["ASI01"],
      path: "middleware",
    },
  ];
}

function checkNoSystemPromptDefense(ctx: DoctorContext): readonly DoctorFinding[] {
  if (ctx.manifest.model.options !== undefined) return [];
  return [
    {
      rule: "goal-hijack:no-system-prompt-defense",
      severity: "MEDIUM",
      category: "GOAL_INTEGRITY",
      message:
        "model.options is undefined — no system prompt hardening or defense instructions configured",
      fix: "Set model.options with system prompt defenses (e.g., instruction boundaries)",
      owasp: ["ASI01"],
      path: "model.options",
    },
  ];
}

export const goalHijackRules: readonly DoctorRule[] = [
  {
    name: "goal-hijack:missing-sanitize-middleware",
    category: "GOAL_INTEGRITY",
    defaultSeverity: "HIGH",
    owasp: ["ASI01"],
    check: checkMissingSanitizeMiddleware,
  },
  {
    name: "goal-hijack:missing-guardrails-middleware",
    category: "GOAL_INTEGRITY",
    defaultSeverity: "MEDIUM",
    owasp: ["ASI01"],
    check: checkMissingGuardrailsMiddleware,
  },
  {
    name: "goal-hijack:no-system-prompt-defense",
    category: "GOAL_INTEGRITY",
    defaultSeverity: "MEDIUM",
    owasp: ["ASI01"],
    check: checkNoSystemPromptDefense,
  },
];
