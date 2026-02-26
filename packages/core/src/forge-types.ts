/**
 * Forge type aliases — extension points for the self-extension system.
 *
 * TrustTier lives in ecs.ts (used by Tool interface).
 * These are additional L0 types used by @koi/forge (L2).
 *
 * Exception: VALID_LIFECYCLE_TRANSITIONS is a pure readonly data constant
 * derived from L0 type definitions, codifying architecture-doc invariants
 * with zero logic.
 */

/** Visibility scope of a forged brick. */
export type ForgeScope = "agent" | "zone" | "global";

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
export type BrickKind = "tool" | "skill" | "agent" | "middleware" | "channel";

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
] as const;

/**
 * Minimum trust tier required per brick kind.
 *
 * - sandbox: tool, skill, agent (sandboxed execution)
 * - promoted: middleware, channel (full interposition)
 */
export const MIN_TRUST_BY_KIND: Readonly<Record<BrickKind, import("./ecs.js").TrustTier>> = {
  tool: "sandbox",
  skill: "sandbox",
  agent: "sandbox",
  middleware: "promoted",
  channel: "promoted",
} as const;
