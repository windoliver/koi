import type { CapsuleVerifier } from "@koi/core/intent-capsule";

/** Configuration for createIntentCapsuleMiddleware. */
export interface IntentCapsuleConfig {
  /** The agent's system prompt — hashed and signed at session start. */
  readonly systemPrompt: string;
  /**
   * Declared objectives for this agent session. Sorted before hashing.
   * Default: []
   */
  readonly objectives?: readonly string[];
  /**
   * Maximum age for capsule entries before TTL eviction (ms).
   * Eviction runs on every onSessionStart call.
   * Default: 3_600_000 (1 hour)
   */
  readonly maxTtlMs?: number;
  /**
   * When true, the signed mandate is injected as a system message at the
   * start of every model call. Default: false.
   */
  readonly injectMandate?: boolean;
  /**
   * Injectable CapsuleVerifier for testing.
   * Default: hash-comparison-only verifier (no asymmetric crypto on hot path).
   */
  readonly verifier?: CapsuleVerifier;
}

/** Default TTL for capsule session entries — 1 hour. */
export const DEFAULT_CAPSULE_TTL_MS = 3_600_000;

/** Resolve config with defaults applied. */
export function resolveConfig(config: IntentCapsuleConfig): Required<IntentCapsuleConfig> {
  return {
    systemPrompt: config.systemPrompt,
    objectives: config.objectives ?? [],
    maxTtlMs: config.maxTtlMs ?? DEFAULT_CAPSULE_TTL_MS,
    injectMandate: config.injectMandate ?? false,
    verifier: config.verifier ?? defaultVerifier,
  };
}

/** Default verifier: mandate hash equality only. No asymmetric crypto on hot path. */
const defaultVerifier: CapsuleVerifier = {
  verify(capsule, currentMandateHash) {
    if (capsule.mandateHash !== currentMandateHash) {
      return { ok: false, reason: "mandate_hash_mismatch" };
    }
    return { ok: true, capsule };
  },
};
