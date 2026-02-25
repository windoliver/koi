/**
 * ASI09 — Overreliance on Agentic Systems / Human Trust rules.
 *
 * Checks for missing human-in-the-loop controls and audit trails.
 */

import type { DoctorContext, DoctorFinding, DoctorRule } from "../types.js";

function checkNoHitlConfig(ctx: DoctorContext): readonly DoctorFinding[] {
  const middleware = ctx.middlewareNames();
  const hasAskList = (ctx.permissions?.ask?.length ?? 0) > 0;
  if (middleware.has("turn-ack") || hasAskList) return [];
  return [
    {
      rule: "human-trust:no-hitl-config",
      severity: "MEDIUM",
      category: "RESILIENCE",
      message:
        "No 'turn-ack' middleware and ask list is empty — agent operates without human oversight",
      fix: "Add { name: 'turn-ack' } to middleware or populate permissions.ask for sensitive tools",
      owasp: ["ASI09"],
      path: "middleware",
    },
  ];
}

function checkNoAuditTrail(ctx: DoctorContext): readonly DoctorFinding[] {
  if (ctx.middlewareNames().has("audit")) return [];
  return [
    {
      rule: "human-trust:no-audit-trail",
      severity: "MEDIUM",
      category: "RESILIENCE",
      message: "No 'audit' middleware configured — agent actions are not logged for review",
      fix: "Add { name: 'audit' } to manifest.middleware",
      owasp: ["ASI09"],
      path: "middleware",
    },
  ];
}

export const humanTrustRules: readonly DoctorRule[] = [
  {
    name: "human-trust:no-hitl-config",
    category: "RESILIENCE",
    defaultSeverity: "MEDIUM",
    owasp: ["ASI09"],
    check: checkNoHitlConfig,
  },
  {
    name: "human-trust:no-audit-trail",
    category: "RESILIENCE",
    defaultSeverity: "MEDIUM",
    owasp: ["ASI09"],
    check: checkNoAuditTrail,
  },
];
