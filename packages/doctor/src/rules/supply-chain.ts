/**
 * ASI04 — Supply Chain Vulnerability rules.
 *
 * Checks for dependency hygiene, excessive deps, known-vulnerable patterns,
 * and forge verification (provenance of forged bricks).
 */

import { getMetadataKey } from "../metadata.js";
import type { DoctorContext, DoctorFinding, DoctorRule } from "../types.js";

const MAX_PRODUCTION_DEPS = 50;

/**
 * Known-vulnerable or high-risk package name patterns.
 * This is a minimal set — real deployments should use a vulnerability database.
 */
const KNOWN_VULNERABLE_PATTERNS: readonly RegExp[] = [
  /^event-stream$/,
  /^ua-parser-js$/,
  /^colors$/,
  /^faker$/,
  /^node-ipc$/,
  /^peacenotwar$/,
];

function checkNoDependenciesProvided(ctx: DoctorContext): readonly DoctorFinding[] {
  const deps = ctx.dependencies();
  if (deps.length > 0) return [];
  if (ctx.packageJson !== undefined) return [];
  return [
    {
      rule: "supply-chain:no-dependencies-provided",
      severity: "LOW",
      category: "SUPPLY_CHAIN",
      message: "No dependencies or package.json provided — supply chain analysis skipped",
      fix: "Provide dependencies or packageJson in DoctorConfig for supply chain scanning",
      owasp: ["ASI04"],
    },
  ];
}

function checkExcessiveDependencies(ctx: DoctorContext): readonly DoctorFinding[] {
  const deps = ctx.dependencies();
  const productionDeps = deps.filter((d) => !d.isDev);
  if (productionDeps.length <= MAX_PRODUCTION_DEPS) return [];
  return [
    {
      rule: "supply-chain:excessive-dependencies",
      severity: "MEDIUM",
      category: "SUPPLY_CHAIN",
      message: `${String(productionDeps.length)} production dependencies (threshold: ${String(MAX_PRODUCTION_DEPS)}) — large attack surface`,
      fix: "Audit and reduce production dependencies to minimize supply chain risk",
      owasp: ["ASI04"],
    },
  ];
}

function checkKnownVulnerablePatterns(ctx: DoctorContext): readonly DoctorFinding[] {
  const deps = ctx.dependencies();
  const vulnerable = deps.filter((d) => KNOWN_VULNERABLE_PATTERNS.some((p) => p.test(d.name)));
  if (vulnerable.length === 0) return [];
  return [
    {
      rule: "supply-chain:known-vulnerable-patterns",
      severity: "HIGH",
      category: "SUPPLY_CHAIN",
      message: `Known-vulnerable packages detected: ${vulnerable.map((d) => d.name).join(", ")}`,
      fix: "Remove or replace these packages with maintained alternatives",
      owasp: ["ASI04"],
    },
  ];
}

function checkForgeVerificationDisabled(ctx: DoctorContext): readonly DoctorFinding[] {
  const forgeRaw = getMetadataKey(ctx.manifest.metadata, "forge");
  if (forgeRaw === undefined || forgeRaw === null) return [];
  if (typeof forgeRaw !== "object") return [];
  const forge = forgeRaw as Readonly<Record<string, unknown>>;
  const verification = forge.verification;
  if (verification === true || (typeof verification === "object" && verification !== null))
    return [];
  return [
    {
      rule: "supply-chain:forge-verification-disabled",
      severity: "HIGH",
      category: "SUPPLY_CHAIN",
      message:
        "Forge is configured but verification is not enabled — forged bricks lack provenance guarantees",
      fix: "Set metadata.forge.verification = true or configure a verification provider",
      owasp: ["ASI04"],
      path: "metadata.forge.verification",
    },
  ];
}

export const supplyChainRules: readonly DoctorRule[] = [
  {
    name: "supply-chain:no-dependencies-provided",
    category: "SUPPLY_CHAIN",
    defaultSeverity: "LOW",
    owasp: ["ASI04"],
    check: checkNoDependenciesProvided,
  },
  {
    name: "supply-chain:excessive-dependencies",
    category: "SUPPLY_CHAIN",
    defaultSeverity: "MEDIUM",
    owasp: ["ASI04"],
    check: checkExcessiveDependencies,
  },
  {
    name: "supply-chain:known-vulnerable-patterns",
    category: "SUPPLY_CHAIN",
    defaultSeverity: "HIGH",
    owasp: ["ASI04"],
    check: checkKnownVulnerablePatterns,
  },
  {
    name: "supply-chain:forge-verification-disabled",
    category: "SUPPLY_CHAIN",
    defaultSeverity: "HIGH",
    owasp: ["ASI04"],
    check: checkForgeVerificationDisabled,
  },
];
