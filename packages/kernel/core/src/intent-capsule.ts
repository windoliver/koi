/**
 * Intent Capsule types — cryptographic mandate binding for ASI01 defense.
 *
 * An IntentCapsule is an unforgeable, signed record of an agent's mandate
 * (system prompt + objectives) created at session start. It defends against
 * OWASP ASI01 (Agentic Goal Hijacking) by making the original mandate
 * tamper-evident and verifiable at runtime.
 *
 * Design decisions:
 * - Mandate is hashed and signed with Ed25519 at onSessionStart (one-time cost)
 * - wrapModelCall verifies hash consistency (cheap — no crypto on hot path)
 * - publicKey is embedded in the capsule for offline/external verification
 * - sessionId is included in the mandate hash for replay-attack prevention
 * - version byte in the canonical payload enables future format evolution
 *
 * Layer: L0 — types only. No implementations, no imports from other packages.
 */

import type { AgentId, SessionId } from "./ecs.js";

// ---------------------------------------------------------------------------
// Branded capsule ID
// ---------------------------------------------------------------------------

declare const __capsuleBrand: unique symbol;

/**
 * Branded string type for intent capsule identifiers.
 * Prevents accidental mixing with other ID types at compile time.
 */
export type CapsuleId = string & { readonly [__capsuleBrand]: "CapsuleId" };

/** Create a branded CapsuleId from a plain string. */
export function capsuleId(raw: string): CapsuleId {
  return raw as CapsuleId;
}

// ---------------------------------------------------------------------------
// Intent capsule — the signed mandate record
// ---------------------------------------------------------------------------

/**
 * Schema version for the canonical mandate payload.
 * Increment when the serialization format changes.
 * Old capsules with a lower version are rejected as incompatible.
 */
export type CapsulePayloadVersion = 1;

/**
 * An immutable, cryptographically signed record of an agent's mandate.
 *
 * Created at session start. The mandateHash binds the capsule to the
 * agent's original instructions (system prompt + objectives + session).
 * The Ed25519 signature proves the capsule was created legitimately
 * and enables offline/external verification.
 *
 * Invariants:
 * - mandateHash === sha256Hex(canonicalize({ version, agentId, sessionId, systemPrompt, objectives }))
 * - signature === Ed25519.sign(mandateHash, privateKey)
 * - publicKey is the SPKI DER base64 counterpart of the signing private key
 */
export interface IntentCapsule {
  /** Unique identifier for this capsule. */
  readonly id: CapsuleId;
  /** Agent that created this capsule. */
  readonly agentId: AgentId;
  /** Session this capsule is bound to. */
  readonly sessionId: SessionId;
  /** SHA-256 hex digest of the canonical mandate payload. */
  readonly mandateHash: string;
  /** Base64-encoded Ed25519 signature of mandateHash. */
  readonly signature: string;
  /** Base64-encoded SPKI DER Ed25519 public key for external verification. */
  readonly publicKey: string;
  /** Unix timestamp ms — when this capsule was created. */
  readonly createdAt: number;
  /** Payload format version — enables future format evolution. */
  readonly version: CapsulePayloadVersion;
}

// ---------------------------------------------------------------------------
// Verification result
// ---------------------------------------------------------------------------

/** Why an intent capsule check failed. */
export type CapsuleViolationReason =
  | "mandate_hash_mismatch"
  | "capsule_not_found"
  | "invalid_signature";

/** Result of checking the intent capsule for a session. */
export type CapsuleVerifyResult =
  | { readonly ok: true; readonly capsule: IntentCapsule }
  | { readonly ok: false; readonly reason: CapsuleViolationReason };

// ---------------------------------------------------------------------------
// CapsuleVerifier — L0 contract (injectable for testing per decision 10-A)
// ---------------------------------------------------------------------------

/**
 * L0 contract for verifying the intent capsule for a session.
 *
 * The default implementation checks that the stored mandateHash matches
 * the hash of the current mandate fields (config values + agentId + sessionId).
 *
 * Implementations may also:
 * - Re-verify the Ed25519 signature (for audit/forensic use cases)
 * - Check against an external attestation store
 *
 * Callers must always await — sync implementations return directly.
 */
export interface CapsuleVerifier {
  /**
   * Verify the intent capsule for the given session.
   *
   * @param capsule - The stored capsule to verify.
   * @param currentMandateHash - SHA-256 of the current canonical mandate payload.
   * @returns CapsuleVerifyResult — ok=true if the mandate is intact.
   */
  readonly verify: (
    capsule: IntentCapsule,
    currentMandateHash: string,
  ) => CapsuleVerifyResult | Promise<CapsuleVerifyResult>;
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

/**
 * Type guard for IntentCapsule.
 * Pure function — permitted in L0 as a side-effect-free data inspector.
 */
export function isIntentCapsule(value: unknown): value is IntentCapsule {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.agentId === "string" &&
    typeof v.sessionId === "string" &&
    typeof v.mandateHash === "string" &&
    typeof v.signature === "string" &&
    typeof v.publicKey === "string" &&
    typeof v.createdAt === "number" &&
    v.version === 1
  );
}
