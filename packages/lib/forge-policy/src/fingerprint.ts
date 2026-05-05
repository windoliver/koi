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
   * Caller-asserted identifier for a custom `complexityOf` scorer.
   * Bound into the fingerprint, but NOT trusted alone — see
   * `complexityOf` below for the implementation-derived component.
   */
  complexityScorerId?: string | undefined,
  /**
   * The actual scorer function. The fingerprint includes a SHA-256
   * digest of `complexityOf.toString()` so two scorers with the same
   * caller-asserted id but different implementations cannot collide
   * on the same fingerprint. Function source is not perfectly stable
   * across runtimes/minifiers, but within a single deployment it
   * detects accidental scorer divergence; combined with a registry
   * convention on the operator side, it is a meaningful provenance
   * signal beyond the caller's free-form id.
   */
  complexityOf?: ((spec: Readonly<Record<string, unknown>>) => number) | undefined,
): string {
  let scorerSourceDigest: string | null = null;
  if (complexityOf !== undefined) {
    try {
      scorerSourceDigest = sha256Hex(Function.prototype.toString.call(complexityOf));
    } catch {
      // A throwing toString (e.g. a Proxy-wrapped function) means we
      // cannot derive provenance — fall through to a sentinel so the
      // fingerprint is still stable but distinct from any honest scorer.
      scorerSourceDigest = "<unprintable>";
    }
  }
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
      complexityScorerId: complexityScorerId ?? null,
      complexityScorerSourceDigest: scorerSourceDigest,
    },
  };
  return sha256Hex(JSON.stringify(normalized));
}

function sha256Hex(input: string): string {
  // `node:crypto` runs identically under Node and Bun; no Bun-only globals.
  return createHash("sha256").update(input).digest("hex");
}
