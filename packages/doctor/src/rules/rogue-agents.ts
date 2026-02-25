/**
 * ASI10 — Rogue Agent / Uncontrolled Autonomy rules.
 *
 * Checks for missing governance controls when delegation is enabled.
 */

import type { DoctorContext, DoctorFinding, DoctorRule } from "../types.js";

function checkNoGovernance(ctx: DoctorContext): readonly DoctorFinding[] {
  if (ctx.delegation === undefined || !ctx.delegation.enabled) return [];
  const middleware = ctx.middlewareNames();
  if (middleware.has("governance")) return [];
  return [
    {
      rule: "rogue-agents:no-governance",
      severity: "HIGH",
      category: "RESILIENCE",
      message:
        "Delegation is enabled but no 'governance' middleware is configured — delegated agents may act without oversight",
      fix: "Add { name: 'governance' } to manifest.middleware when using delegation",
      owasp: ["ASI10"],
      path: "middleware",
    },
  ];
}

export const rogueAgentsRules: readonly DoctorRule[] = [
  {
    name: "rogue-agents:no-governance",
    category: "RESILIENCE",
    defaultSeverity: "HIGH",
    owasp: ["ASI10"],
    check: checkNoGovernance,
  },
];
