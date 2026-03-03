/**
 * ASI10 — Rogue Agent / Uncontrolled Autonomy rules.
 *
 * Checks for missing governance controls and monitoring when delegation is enabled.
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

function checkNoAgentMonitor(ctx: DoctorContext): readonly DoctorFinding[] {
  if (ctx.delegation === undefined || !ctx.delegation.enabled) return [];
  const middleware = ctx.middlewareNames();
  if (middleware.has("agent-monitor") || middleware.has("monitor")) return [];
  return [
    {
      rule: "rogue-agents:no-agent-monitor",
      severity: "MEDIUM",
      category: "RESILIENCE",
      message:
        "Delegation is enabled but no monitoring middleware is configured — agent activity is not observed for anomalies",
      fix: "Add { name: 'agent-monitor' } to manifest.middleware when using delegation",
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
  {
    name: "rogue-agents:no-agent-monitor",
    category: "RESILIENCE",
    defaultSeverity: "MEDIUM",
    owasp: ["ASI10"],
    check: checkNoAgentMonitor,
  },
];
