import type { ForgePolicyConfig } from "./config.js";

/**
 * Stable hash over the operator-controlled fields of a `ForgePolicyConfig`.
 * Sorts list-shaped inputs so semantically equal configs (e.g. permuted
 * `allowedKinds`) produce equal fingerprints. Returns a hex-encoded
 * 32-bit FNV-1a digest — fast, collision-resistant enough for forensic
 * correlation of audit entries to the policy version that produced them
 * (NOT a cryptographic attestation).
 */
export function computeConfigFingerprint(config: ForgePolicyConfig): string {
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
  };
  return fnv1a32Hex(JSON.stringify(normalized));
}

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnv1a32Hex(input: string): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
