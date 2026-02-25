/**
 * ASI03 — Privilege Escalation / Abuse rules.
 *
 * Checks for overly broad permissions and missing access controls.
 */

import type { DoctorContext, DoctorFinding, DoctorRule } from "../types.js";

const OVERLY_BROAD_THRESHOLD = 10;

function checkOverlyBroadPermissions(ctx: DoctorContext): readonly DoctorFinding[] {
  const allow = ctx.permissions?.allow;
  if (allow === undefined || allow.length <= OVERLY_BROAD_THRESHOLD) return [];
  return [
    {
      rule: "privilege-abuse:overly-broad-permissions",
      severity: "MEDIUM",
      category: "ACCESS_CONTROL",
      message: `permissions.allow has ${String(allow.length)} entries (threshold: ${String(OVERLY_BROAD_THRESHOLD)}) — agent has access to a wide surface area`,
      fix: "Reduce the allow list to only the tools this agent actually needs",
      owasp: ["ASI03"],
      path: "permissions.allow",
    },
  ];
}

function checkNoPermissionsConfig(ctx: DoctorContext): readonly DoctorFinding[] {
  if (ctx.permissions !== undefined) return [];
  return [
    {
      rule: "privilege-abuse:no-permissions-config",
      severity: "HIGH",
      category: "ACCESS_CONTROL",
      message: "No permissions config defined — agent implicitly has access to all tools",
      fix: "Add a permissions block with explicit allow, deny, and ask lists",
      owasp: ["ASI03"],
      path: "permissions",
    },
  ];
}

function checkAskListEmpty(ctx: DoctorContext): readonly DoctorFinding[] {
  const ask = ctx.permissions?.ask;
  if (ask !== undefined && ask.length > 0) return [];
  return [
    {
      rule: "privilege-abuse:ask-list-empty",
      severity: "LOW",
      category: "ACCESS_CONTROL",
      message:
        "permissions.ask is empty or undefined — no tools require human-in-the-loop approval",
      fix: "Add sensitive tools to the ask list to require human confirmation",
      owasp: ["ASI03"],
      path: "permissions.ask",
    },
  ];
}

export const privilegeAbuseRules: readonly DoctorRule[] = [
  {
    name: "privilege-abuse:overly-broad-permissions",
    category: "ACCESS_CONTROL",
    defaultSeverity: "MEDIUM",
    owasp: ["ASI03"],
    check: checkOverlyBroadPermissions,
  },
  {
    name: "privilege-abuse:no-permissions-config",
    category: "ACCESS_CONTROL",
    defaultSeverity: "HIGH",
    owasp: ["ASI03"],
    check: checkNoPermissionsConfig,
  },
  {
    name: "privilege-abuse:ask-list-empty",
    category: "ACCESS_CONTROL",
    defaultSeverity: "LOW",
    owasp: ["ASI03"],
    check: checkAskListEmpty,
  },
];
