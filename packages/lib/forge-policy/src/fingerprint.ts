import { createHash } from "node:crypto";
import type { ForgePolicyConfig } from "./config.js";
import { MAX_ARRAY_LENGTH, STRUCTURAL_BUDGET_BYTES } from "./evaluate.js";

/**
 * Bumped whenever the evaluator changes its allow/deny semantics in a way
 * that is NOT visible through `ForgePolicyConfig` alone (e.g. a tighter
 * structural budget, a new fail-closed case, or a different complexity
 * heuristic). Audit records can then distinguish verdicts produced by
 * different evaluator generations even when the operator config is
 * identical. Bump on every semantic change.
 */
export const POLICY_EVALUATOR_VERSION = 2;

/**
 * Stable hash over the operator-controlled fields of a `ForgePolicyConfig`.
 * Sorts list-shaped inputs so semantically equal configs (e.g. permuted
 * `allowedKinds`) produce equal fingerprints. Returns the 64-char
 * lowercase-hex SHA-256 digest of the canonical normalization — a
 * cryptographic digest so two distinct policy configs cannot collide on
 * the same fingerprint within the audit trail.
 */
export function computeConfigFingerprint(
  config: ForgePolicyConfig,
  /**
   * Caller-supplied scorer provenance metadata when a custom
   * `complexityOf` is in play. Both `id` and `version` are bound
   * into the fingerprint. The caller MUST bump `version` whenever
   * the scorer's runtime behavior can change (closures, ambient
   * state, feature flags, implementation diff). Source-text hashing
   * is intentionally not used: closures and ambient state make
   * source text a misleading provenance signal.
   */
  complexityScorer?: { readonly id: string; readonly version: string } | undefined,
): string {
  const normalized = {
    allowedKinds: [...config.allowedKinds].sort(),
    maxScope: config.maxScope,
    requireApprovalAtOrAbove: config.requireApprovalAtOrAbove,
    budget: {
      maxForgesPerSession: config.budget.maxForgesPerSession,
      computeTimeBudgetMs: config.budget.computeTimeBudgetMs,
      demandThreshold: config.budget.demandThreshold,
      cooldownMs: config.budget.cooldownMs,
    },
    maxComplexity: config.maxComplexity ?? null,
    forbiddenNamespaces:
      config.forbiddenNamespaces === undefined ? [] : [...config.forbiddenNamespaces].sort(),
    evaluator: {
      version: POLICY_EVALUATOR_VERSION,
      structuralBudgetBytes: STRUCTURAL_BUDGET_BYTES,
      maxArrayLength: MAX_ARRAY_LENGTH,
      complexityScorer:
        complexityScorer === undefined
          ? null
          : { id: complexityScorer.id, version: complexityScorer.version },
    },
  };
  return sha256Hex(JSON.stringify(normalized));
}

function sha256Hex(input: string): string {
  // `node:crypto` runs identically under Node and Bun; no Bun-only globals.
  return createHash("sha256").update(input).digest("hex");
}
