/**
 * ASI02 — Tool Misuse rules.
 *
 * Checks for overly permissive tool access and dangerous tool configurations.
 */

import type { DoctorContext, DoctorFinding, DoctorRule } from "../types.js";

const DANGEROUS_TOOL_PATTERNS = /^(exec|shell|eval|run_command|execute|system)$/i;

function checkWildcardAllow(ctx: DoctorContext): readonly DoctorFinding[] {
  const allow = ctx.permissions?.allow;
  if (allow === undefined) return [];
  if (!allow.some((p) => p === "*")) return [];
  return [
    {
      rule: "tool-misuse:wildcard-allow",
      severity: "CRITICAL",
      category: "TOOL_SAFETY",
      message: "permissions.allow contains '*' — all tools are permitted without restriction",
      fix: "Replace wildcard with an explicit allow-list of required tools",
      owasp: ["ASI02"],
      path: "permissions.allow",
    },
  ];
}

function checkNoDenyList(ctx: DoctorContext): readonly DoctorFinding[] {
  const deny = ctx.permissions?.deny;
  if (deny !== undefined && deny.length > 0) return [];
  return [
    {
      rule: "tool-misuse:no-deny-list",
      severity: "MEDIUM",
      category: "TOOL_SAFETY",
      message: "permissions.deny is empty or undefined — no tools are explicitly blocked",
      fix: "Add a deny list for known dangerous tools (e.g., exec, shell, eval)",
      owasp: ["ASI02"],
      path: "permissions.deny",
    },
  ];
}

function checkDangerousToolNames(ctx: DoctorContext): readonly DoctorFinding[] {
  const tools = ctx.toolNames();
  const middleware = ctx.middlewareNames();
  const hasSandbox = middleware.has("sandbox");

  const dangerous = [...tools].filter((t) => DANGEROUS_TOOL_PATTERNS.test(t));
  if (dangerous.length === 0) return [];
  if (hasSandbox) return [];

  return [
    {
      rule: "tool-misuse:dangerous-tool-names",
      severity: "HIGH",
      category: "TOOL_SAFETY",
      message: `Dangerous tools configured without sandbox: ${dangerous.join(", ")}`,
      fix: "Add 'sandbox' middleware or remove dangerous tools from the manifest",
      owasp: ["ASI02"],
      path: "tools",
    },
  ];
}

export const toolMisuseRules: readonly DoctorRule[] = [
  {
    name: "tool-misuse:wildcard-allow",
    category: "TOOL_SAFETY",
    defaultSeverity: "CRITICAL",
    owasp: ["ASI02"],
    check: checkWildcardAllow,
  },
  {
    name: "tool-misuse:no-deny-list",
    category: "TOOL_SAFETY",
    defaultSeverity: "MEDIUM",
    owasp: ["ASI02"],
    check: checkNoDenyList,
  },
  {
    name: "tool-misuse:dangerous-tool-names",
    category: "TOOL_SAFETY",
    defaultSeverity: "HIGH",
    owasp: ["ASI02"],
    check: checkDangerousToolNames,
  },
];
