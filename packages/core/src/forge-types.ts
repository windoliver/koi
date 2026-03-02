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

// ---------------------------------------------------------------------------
// Trust transition caller discriminant
// ---------------------------------------------------------------------------

/** Who is requesting a trust transition — agents cannot demote, systems can. */
export type TrustTransitionCaller = "agent" | "system";

// ---------------------------------------------------------------------------
// Demotion criteria — thresholds for automated trust demotion
// ---------------------------------------------------------------------------

/** Configuration for automated trust tier demotion on sustained error rate. */
export interface DemotionCriteria {
  /** Error rate threshold to trigger demotion (0-1). E.g., 0.3 = 30%. */
  readonly errorRateThreshold: number;
  /** Number of recent invocations to evaluate for demotion. */
  readonly windowSize: number;
  /** Minimum number of filled slots before demotion can trigger. */
  readonly minSampleSize: number;
  /** Don't demote within this many ms of a promotion. */
  readonly gracePeriodMs: number;
  /** Minimum time between consecutive demotions in ms. */
  readonly demotionCooldownMs: number;
}

/** Sensible defaults for demotion criteria. */
export const DEFAULT_DEMOTION_CRITERIA: DemotionCriteria = Object.freeze({
  errorRateThreshold: 0.3,
  windowSize: 20,
  minSampleSize: 10,
  gracePeriodMs: 3_600_000,
  demotionCooldownMs: 1_800_000,
});

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
 * Minimum trust tier required per brick kind.
 *
 * - sandbox: tool, skill, agent, composite (sandboxed execution)
 * - promoted: middleware, channel (full interposition)
 */
export const MIN_TRUST_BY_KIND: Readonly<Record<BrickKind, import("./ecs.js").TrustTier>> = {
  tool: "sandbox",
  skill: "sandbox",
  agent: "sandbox",
  middleware: "promoted",
  channel: "promoted",
  composite: "sandbox",
} as const;
