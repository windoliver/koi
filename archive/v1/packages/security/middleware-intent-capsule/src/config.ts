/**
 * IntentCapsuleConfig — configuration for createIntentCapsuleMiddleware.
 */

import type { CapsuleVerifier } from "@koi/core/intent-capsule";
import { verifyEd25519 } from "@koi/crypto-utils";

/** Configuration for the intent capsule middleware. */
export interface IntentCapsuleConfig {
  /**
   * The agent's system prompt (its mission instructions).
   * This is hashed into the mandate at session start.
   * Typically sourced from manifest.model.options.system or similar.
   */
  readonly systemPrompt: string;
  /**
   * Declared objectives for this agent session.
   * Hashed alongside systemPrompt. Order does not matter — sorted before hashing.
   * Default: [] (no explicit objectives beyond the system prompt).
   */
  readonly objectives?: readonly string[];
  /**
   * Maximum age for capsule entries in the session Map before TTL eviction.
   * Eviction runs on every onSessionStart call.
   * Default: 3_600_000 ms (1 hour).
   */
  readonly maxTtlMs?: number;
  /**
   * If true, the signed mandate is injected as a system message at the start
   * of every model call. This keeps the model continuously aware of its
   * cryptographically-bound original mission.
   * Default: false.
   */
  readonly injectMandate?: boolean;
  /**
   * Injectable CapsuleVerifier for testing (decision 10-A).
   * When provided, replaces the default hash-comparison verifier.
   * Production code should not set this.
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

/**
 * Default CapsuleVerifier: checks mandate hash equality AND verifies
 * the Ed25519 signature against the capsule's public key.
 * Hash check first (cheap), then signature verification (crypto).
 */
const defaultVerifier: CapsuleVerifier = {
  verify(capsule, currentMandateHash) {
    if (capsule.mandateHash !== currentMandateHash) {
      return { ok: false, reason: "mandate_hash_mismatch" };
    }
    if (!verifyEd25519(capsule.mandateHash, capsule.publicKey, capsule.signature)) {
      return { ok: false, reason: "invalid_signature" };
    }
    return { ok: true, capsule };
  },
};
