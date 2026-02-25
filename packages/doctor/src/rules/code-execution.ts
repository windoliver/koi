/**
 * ASI05 — Insecure Code Execution rules.
 *
 * Checks for missing sandboxing and permission controls
 * when tools are configured.
 */

import type { DoctorContext, DoctorFinding, DoctorRule } from "../types.js";

function isObjectWithPreset(value: unknown): value is { readonly preset: unknown } {
  return value !== null && value !== undefined && typeof value === "object" && "preset" in value;
}

function checkMissingSandboxMiddleware(ctx: DoctorContext): readonly DoctorFinding[] {
  const tools = ctx.toolNames();
  if (tools.size === 0) return [];
  if (ctx.middlewareNames().has("sandbox")) return [];
  return [
    {
      rule: "code-execution:missing-sandbox-middleware",
      severity: "HIGH",
      category: "TOOL_SAFETY",
      message:
        "Tools are configured but no 'sandbox' middleware is present — tool execution is not sandboxed",
      fix: "Add { name: 'sandbox' } to manifest.middleware",
      owasp: ["ASI05"],
      path: "middleware",
    },
  ];
}

function checkPermissiveForge(ctx: DoctorContext): readonly DoctorFinding[] {
  const metadata = ctx.manifest.metadata;
  if (metadata === undefined) return [];

  const forgeRaw: unknown = metadata.forge;
  if (!isObjectWithPreset(forgeRaw)) return [];
  if (forgeRaw.preset !== "permissive") return [];
  return [
    {
      rule: "code-execution:permissive-forge",
      severity: "HIGH",
      category: "TOOL_SAFETY",
      message: "forge.preset is 'permissive' — forged code runs with minimal restrictions",
      fix: "Use a restricted forge preset or remove forge.preset from metadata",
      owasp: ["ASI05"],
      path: "metadata.forge.preset",
    },
  ];
}

function checkNoPermissionsMiddleware(ctx: DoctorContext): readonly DoctorFinding[] {
  const tools = ctx.toolNames();
  if (tools.size === 0) return [];
  if (ctx.middlewareNames().has("permissions")) return [];
  return [
    {
      rule: "code-execution:no-permissions-middleware",
      severity: "HIGH",
      category: "TOOL_SAFETY",
      message:
        "Tools are configured but no 'permissions' middleware is present — tool calls are not permission-checked",
      fix: "Add { name: 'permissions' } to manifest.middleware",
      owasp: ["ASI05"],
      path: "middleware",
    },
  ];
}

export const codeExecutionRules: readonly DoctorRule[] = [
  {
    name: "code-execution:missing-sandbox-middleware",
    category: "TOOL_SAFETY",
    defaultSeverity: "HIGH",
    owasp: ["ASI05"],
    check: checkMissingSandboxMiddleware,
  },
  {
    name: "code-execution:permissive-forge",
    category: "TOOL_SAFETY",
    defaultSeverity: "HIGH",
    owasp: ["ASI05"],
    check: checkPermissiveForge,
  },
  {
    name: "code-execution:no-permissions-middleware",
    category: "TOOL_SAFETY",
    defaultSeverity: "HIGH",
    owasp: ["ASI05"],
    check: checkNoPermissionsMiddleware,
  },
];
