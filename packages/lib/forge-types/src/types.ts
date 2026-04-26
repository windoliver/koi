/**
 * @koi/forge-types — shared type + contract surfaces for L2 forge packages.
 *
 * L0u: depends only on `@koi/core`. No runtime logic except pure type guards
 * and discriminated-union helpers (zero side effects).
 *
 * Concept map:
 *   ForgeDemand → ForgeCandidate → ForgeArtifact   (pipeline)
 *   ForgePolicy → ForgePolicyVerdict                (gating)
 *   ForgeLifecycleState                              (process state)
 *   ForgeEvent                                       (observability)
 */

import type {
  BrickArtifact,
  BrickKind,
  ForgeBudget,
  ForgeDemandSignal,
  ForgeScope,
  ForgeVerificationSummary,
} from "@koi/core";

// ---------------------------------------------------------------------------
// Demand → Candidate → Artifact pipeline
// ---------------------------------------------------------------------------

/** Lifecycle status of a recorded demand signal. */
export type ForgeDemandStatus = "open" | "accepted" | "rejected" | "expired";

/**
 * A passively-detected forge demand record. Wraps the L0 `ForgeDemandSignal`
 * with persistence metadata (status, dedup count, observation timestamps).
 */
export interface ForgeDemand {
  readonly signal: ForgeDemandSignal;
  readonly status: ForgeDemandStatus;
  readonly observedAt: number;
  readonly resolvedAt?: number | undefined;
  /** Number of times this trigger has been seen — drives priority. */
  readonly occurrences: number;
}

/**
 * A proposal to forge a specific brick. Produced by demand → candidate logic
 * (push from policies, pull from demand signals); consumed by forge tools.
 */
export interface ForgeCandidate {
  readonly id: string;
  readonly kind: BrickKind;
  readonly name: string;
  readonly description: string;
  /** Demand record this candidate resolves, if pull-driven. */
  readonly demandId?: string | undefined;
  /** 0..1 priority — higher means synthesize sooner. */
  readonly priority: number;
  readonly proposedScope: ForgeScope;
  readonly createdAt: number;
}

/**
 * The output of a successful forge pipeline. Wraps the persisted
 * `BrickArtifact` with forge-process metadata (which candidate produced it,
 * the verification digest, lifecycle state at publication time).
 */
export interface ForgeArtifact {
  readonly brick: BrickArtifact;
  readonly candidateId: string;
  readonly lifecycle: ForgeLifecycleState;
  readonly verification: ForgeVerificationSummary;
  readonly forgedAt: number;
  /** Agent ID that authorized the forge. */
  readonly forgedBy: string;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/** Forge policy — what is allowed to be forged, by whom, with which budget. */
export interface ForgePolicy {
  readonly allowedKinds: readonly BrickKind[];
  readonly maxScope: ForgeScope;
  readonly budget: ForgeBudget;
  /** Scope at or above which a forge requires human approval. */
  readonly requireApprovalAtOrAbove: ForgeScope;
}

/** Verdict of evaluating a candidate against a `ForgePolicy`. */
export type ForgePolicyVerdict =
  | { readonly decision: "allow" }
  | { readonly decision: "require-approval"; readonly reason: string }
  | { readonly decision: "deny"; readonly reason: string };

// ---------------------------------------------------------------------------
// Forge process lifecycle
// ---------------------------------------------------------------------------

/**
 * The forge **process** lifecycle (distinct from `BrickLifecycle`, which
 * tracks the brick after publication). Linear, with terminal failure/retired.
 */
export type ForgeLifecycleState =
  | "detected"
  | "proposed"
  | "synthesizing"
  | "verifying"
  | "published"
  | "failed"
  | "retired";

const FORGE_LIFECYCLE_STATES: ReadonlySet<string> = new Set<ForgeLifecycleState>([
  "detected",
  "proposed",
  "synthesizing",
  "verifying",
  "published",
  "failed",
  "retired",
]);

const TERMINAL_FORGE_LIFECYCLE_STATES: ReadonlySet<ForgeLifecycleState> =
  new Set<ForgeLifecycleState>(["published", "failed", "retired"]);

/** Runtime guard for `ForgeLifecycleState` values. */
export function isForgeLifecycleState(value: string): value is ForgeLifecycleState {
  return FORGE_LIFECYCLE_STATES.has(value);
}

/** True when no further transitions are possible. */
export function isTerminalForgeLifecycle(state: ForgeLifecycleState): boolean {
  return TERMINAL_FORGE_LIFECYCLE_STATES.has(state);
}

// ---------------------------------------------------------------------------
// Tool / middleware contracts
// ---------------------------------------------------------------------------

/**
 * Input contract for forge tools (`forge_tool`, `forge_skill`, …).
 * Concrete tool implementations live in `@koi/forge-tools`.
 */
export interface ForgeToolInput {
  readonly kind: BrickKind;
  readonly name: string;
  readonly description: string;
  /** Kind-specific specification (code, manifest YAML, brick IDs, etc.). */
  readonly spec: Readonly<Record<string, unknown>>;
  readonly scope?: ForgeScope | undefined;
}

/** Output contract for forge tools. */
export interface ForgeToolResult {
  readonly ok: boolean;
  readonly artifact?: ForgeArtifact | undefined;
  readonly error?: string | undefined;
}

/** Configuration contract for the demand-detection middleware. */
export interface ForgeMiddlewareConfig {
  readonly enabled: boolean;
  /** Emit `demand_detected` events when triggers fire. */
  readonly emitDemand: boolean;
  /** Automatically advance accepted demands into the synthesis pipeline. */
  readonly autoSynthesize: boolean;
}

// ---------------------------------------------------------------------------
// Observability events
// ---------------------------------------------------------------------------

/** Discriminated union of forge observability events. */
export type ForgeEvent =
  | { readonly kind: "demand_detected"; readonly demand: ForgeDemand }
  | { readonly kind: "candidate_proposed"; readonly candidate: ForgeCandidate }
  | { readonly kind: "synthesize_started"; readonly candidateId: string }
  | { readonly kind: "verify_started"; readonly candidateId: string }
  | {
      readonly kind: "forge_completed";
      readonly candidateId: string;
      readonly artifact: ForgeArtifact;
    }
  | {
      readonly kind: "forge_failed";
      readonly candidateId: string;
      readonly stage: ForgeLifecycleState;
      readonly reason: string;
    }
  | {
      readonly kind: "policy_decision";
      readonly candidateId: string;
      readonly verdict: ForgePolicyVerdict;
    };

const FORGE_EVENT_KINDS: ReadonlySet<string> = new Set<ForgeEvent["kind"]>([
  "demand_detected",
  "candidate_proposed",
  "synthesize_started",
  "verify_started",
  "forge_completed",
  "forge_failed",
  "policy_decision",
]);

/** Runtime guard for `ForgeEvent` — checks shape + known `kind` discriminant. */
export function isForgeEvent(value: unknown): value is ForgeEvent {
  if (value === null || typeof value !== "object" || !("kind" in value)) return false;
  const { kind } = value;
  return typeof kind === "string" && FORGE_EVENT_KINDS.has(kind);
}
