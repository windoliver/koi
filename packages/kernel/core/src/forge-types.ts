/**
 * Forge type aliases — extension points for the self-extension system.
 *
 * ToolPolicy lives in ecs.ts (used by Tool interface).
 * These are additional L0 types used by @koi/forge (L2).
 *
 * Exception: VALID_LIFECYCLE_TRANSITIONS and SANDBOX_REQUIRED_BY_KIND are
 * pure readonly data constants derived from L0 type definitions, codifying
 * architecture-doc invariants with zero logic.
 */

/** Visibility scope of a forged brick. */
export type ForgeScope = "agent" | "zone" | "global";

// ---------------------------------------------------------------------------
// Trust tier — author-level trust classification for forge bricks
// ---------------------------------------------------------------------------

/**
 * Trust tier for a brick based on cryptographic signature verification.
 *
 * - "local"     — Unverified; user's own forged brick, no signature.
 * - "community" — Signed by the brick author (Ed25519 key pair).
 * - "verified"  — Signed by the Koi registry or trusted authority.
 */
export type TrustTier = "local" | "community" | "verified";

// ---------------------------------------------------------------------------
// Brick signature — Ed25519 signature metadata attached to brick artifacts
// ---------------------------------------------------------------------------

/** Cryptographic signature metadata for a brick artifact. */
export interface BrickSignature {
  /** Signing algorithm identifier (e.g., "ed25519"). */
  readonly algorithm: string;
  /** Base64-encoded signature bytes. */
  readonly signature: string;
  /** Base64-encoded SPKI DER public key of the signer. */
  readonly publicKey: string;
  /** Optional key identifier for key rotation / registry lookup. */
  readonly keyId?: string | undefined;
  /** Epoch millis when the signature was created. */
  readonly signedAt: number;
}

// ---------------------------------------------------------------------------
// Trust transition caller discriminant
// ---------------------------------------------------------------------------

/** Who is requesting a trust transition — agents cannot demote, systems can. */
export type TrustTransitionCaller = "agent" | "system";

// ---------------------------------------------------------------------------
// Mutation pressure — fitness-based forge protection zones
// ---------------------------------------------------------------------------

/** Mutation pressure zone derived from brick fitness score. */
export type MutationPressure = "frozen" | "stable" | "experimental" | "aggressive";

/** Threshold policy for mapping fitness scores to mutation pressure zones. */
export interface MutationPressurePolicy {
  /** Fitness above this threshold → frozen (block forge). Default: 0.9. */
  readonly frozenThreshold: number;
  /** Fitness above this threshold → stable (normal). Default: 0.5. */
  readonly stableThreshold: number;
  /** Fitness above this threshold → experimental. Default: 0.2. Below → aggressive. */
  readonly experimentalThreshold: number;
}

/** Default thresholds for mutation pressure zone classification. */
export const DEFAULT_MUTATION_PRESSURE_POLICY: MutationPressurePolicy = Object.freeze({
  frozenThreshold: 0.9,
  stableThreshold: 0.5,
  experimentalThreshold: 0.2,
});

/** Lifecycle state of a forged brick artifact. */
export type BrickLifecycle =
  | "draft"
  | "verifying"
  | "active"
  | "failed"
  | "deprecated"
  | "quarantined";

// ---------------------------------------------------------------------------
// Valid lifecycle transitions (architecture-doc invariants)
// ---------------------------------------------------------------------------

/**
 * Allowed lifecycle state transitions per Koi architecture doc.
 * L2 forge packages use this to validate transitions.
 *
 * Transitions:
 *   draft       → verifying, failed
 *   verifying   → active, failed
 *   active      → deprecated, quarantined
 *   failed      → (none — terminal)
 *   deprecated  → quarantined
 *   quarantined → draft (remediation — must re-earn trust)
 */
export const VALID_LIFECYCLE_TRANSITIONS: Readonly<
  Record<BrickLifecycle, readonly BrickLifecycle[]>
> = Object.freeze({
  draft: ["verifying", "failed"] as const,
  verifying: ["active", "failed"] as const,
  active: ["deprecated", "quarantined"] as const,
  failed: [] as const,
  deprecated: ["quarantined"] as const,
  quarantined: ["draft"] as const,
});

/** Kind of forged brick. */
export type BrickKind = "tool" | "skill" | "agent" | "middleware" | "channel" | "composite";

// ---------------------------------------------------------------------------
// Brick-kind constants (architecture-doc invariants)
// ---------------------------------------------------------------------------

/** All valid brick kinds as a readonly tuple. */
export const ALL_BRICK_KINDS: readonly BrickKind[] = [
  "tool",
  "skill",
  "agent",
  "middleware",
  "channel",
  "composite",
] as const;

/** Maximum number of steps in a composite pipeline. */
export const MAX_PIPELINE_STEPS = 20;

/**
 * Whether sandboxing is required per brick kind.
 *
 * - true: tool, skill, agent, composite (must run sandboxed)
 * - false: middleware, channel (full interposition, no sandbox)
 */
export const SANDBOX_REQUIRED_BY_KIND: Readonly<Record<BrickKind, boolean>> = {
  tool: true,
  skill: true,
  agent: true,
  middleware: false,
  channel: false,
  composite: true,
} as const;

/** Validation result from validatePolicyForKind. */
export type PolicyValidationResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string };

/**
 * Validates that a ToolPolicy is compatible with a BrickKind.
 *
 * Rules:
 * - Middleware/channel cannot have sandbox: true (they need full interposition)
 * - Resources with timeoutMs: 0 are invalid (must be positive or omitted)
 *
 * Pure function — no side effects.
 */
export function validatePolicyForKind(
  policy: import("./ecs.js").ToolPolicy,
  kind: BrickKind,
): PolicyValidationResult {
  // Middleware and channels cannot be sandboxed
  if (policy.sandbox && !SANDBOX_REQUIRED_BY_KIND[kind]) {
    return {
      valid: false,
      reason: `${kind} cannot have sandbox: true — middleware and channels require full interposition`,
    };
  }

  // Validate resource limits if present
  const timeout = policy.capabilities.resources?.timeoutMs;
  if (timeout !== undefined && timeout <= 0) {
    return {
      valid: false,
      reason: `resources.timeoutMs must be positive, got ${String(timeout)}`,
    };
  }

  return { valid: true };
}
