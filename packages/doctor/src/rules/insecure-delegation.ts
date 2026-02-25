/**
 * ASI07 — Insecure Agent Delegation rules.
 *
 * Checks for missing signature secrets, excessive chain depth,
 * and overly long TTL in delegation config.
 */

import type { DoctorContext, DoctorFinding, DoctorRule } from "../types.js";

const MAX_SAFE_CHAIN_DEPTH = 5;
const MAX_SAFE_TTL_MS = 86_400_000; // 24 hours

function checkUnsignedGrants(ctx: DoctorContext): readonly DoctorFinding[] {
  if (ctx.delegation === undefined || !ctx.delegation.enabled) return [];
  if (ctx.envKeys().has("DELEGATION_SECRET")) return [];
  return [
    {
      rule: "insecure-delegation:unsigned-grants",
      severity: "CRITICAL",
      category: "ACCESS_CONTROL",
      message:
        "Delegation is enabled but DELEGATION_SECRET env var is not set — grants cannot be signed",
      fix: "Set DELEGATION_SECRET in your environment or secret manager",
      owasp: ["ASI07"],
      path: "delegation",
    },
  ];
}

function checkExcessiveChainDepth(ctx: DoctorContext): readonly DoctorFinding[] {
  if (ctx.delegation === undefined || !ctx.delegation.enabled) return [];
  if (ctx.delegation.maxChainDepth <= MAX_SAFE_CHAIN_DEPTH) return [];
  return [
    {
      rule: "insecure-delegation:excessive-chain-depth",
      severity: "MEDIUM",
      category: "ACCESS_CONTROL",
      message: `delegation.maxChainDepth is ${String(ctx.delegation.maxChainDepth)} (max safe: ${String(MAX_SAFE_CHAIN_DEPTH)}) — deep re-delegation chains increase blast radius`,
      fix: `Reduce maxChainDepth to ${String(MAX_SAFE_CHAIN_DEPTH)} or lower`,
      owasp: ["ASI07"],
      path: "delegation.maxChainDepth",
    },
  ];
}

function checkLongTtl(ctx: DoctorContext): readonly DoctorFinding[] {
  if (ctx.delegation === undefined || !ctx.delegation.enabled) return [];
  if (ctx.delegation.defaultTtlMs <= MAX_SAFE_TTL_MS) return [];
  return [
    {
      rule: "insecure-delegation:long-ttl",
      severity: "MEDIUM",
      category: "ACCESS_CONTROL",
      message: `delegation.defaultTtlMs is ${String(ctx.delegation.defaultTtlMs)}ms (max safe: 24h) — long-lived grants increase exposure window`,
      fix: "Reduce defaultTtlMs to 86400000 (24 hours) or lower",
      owasp: ["ASI07"],
      path: "delegation.defaultTtlMs",
    },
  ];
}

export const insecureDelegationRules: readonly DoctorRule[] = [
  {
    name: "insecure-delegation:unsigned-grants",
    category: "ACCESS_CONTROL",
    defaultSeverity: "CRITICAL",
    owasp: ["ASI07"],
    check: checkUnsignedGrants,
  },
  {
    name: "insecure-delegation:excessive-chain-depth",
    category: "ACCESS_CONTROL",
    defaultSeverity: "MEDIUM",
    owasp: ["ASI07"],
    check: checkExcessiveChainDepth,
  },
  {
    name: "insecure-delegation:long-ttl",
    category: "ACCESS_CONTROL",
    defaultSeverity: "MEDIUM",
    owasp: ["ASI07"],
    check: checkLongTtl,
  },
];
