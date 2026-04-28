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
import { isBrickKind } from "@koi/core";

// `Record<Union, true>` constraints force a build-time error if the upstream
// `@koi/core` union widens, preventing runtime / type-level drift.
const FORGE_SCOPE_VALUES = {
  agent: true,
  zone: true,
  global: true,
} as const satisfies Record<ForgeScope, true>;

function isForgeScope(value: unknown): value is ForgeScope {
  return typeof value === "string" && Object.hasOwn(FORGE_SCOPE_VALUES, value);
}

// ---------------------------------------------------------------------------
// Demand → Candidate → Artifact pipeline
// ---------------------------------------------------------------------------

/** Lifecycle status of a recorded demand signal. */
export type ForgeDemandStatus = "open" | "accepted" | "rejected" | "expired";

const FORGE_DEMAND_STATUS_VALUES = {
  open: true,
  accepted: true,
  rejected: true,
  expired: true,
} as const satisfies Record<ForgeDemandStatus, true>;

function isForgeDemandStatus(value: unknown): value is ForgeDemandStatus {
  return typeof value === "string" && Object.hasOwn(FORGE_DEMAND_STATUS_VALUES, value);
}

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
 * Terminal success states a `ForgeArtifact` may carry. Pre-publication
 * (`detected`, `proposed`, `synthesizing`, `verifying`) and `failed` are
 * forbidden — an artifact only exists once the pipeline has published it.
 */
export type PublishedForgeLifecycleState = "published" | "retired";

const PUBLISHED_FORGE_LIFECYCLE_VALUES = {
  published: true,
  retired: true,
} as const satisfies Record<PublishedForgeLifecycleState, true>;

/** Runtime guard for `PublishedForgeLifecycleState` values. */
export function isPublishedForgeLifecycleState(
  value: unknown,
): value is PublishedForgeLifecycleState {
  return typeof value === "string" && Object.hasOwn(PUBLISHED_FORGE_LIFECYCLE_VALUES, value);
}

/**
 * The output of a successful forge pipeline. Wraps the persisted
 * `BrickArtifact` with forge-process metadata (which candidate produced it,
 * the verification digest, lifecycle state). The `lifecycle` slot is narrowed
 * to `PublishedForgeLifecycleState` so a failed or in-flight pipeline cannot
 * be represented as an artifact.
 *
 * `ForgeArtifact` covers both `published` (current) and `retired`
 * (post-publication) states. Use `CompletedForgeArtifact` (below) for the
 * specific case of a `forge_completed` event payload, where the lifecycle at
 * the moment of completion is necessarily `"published"`.
 */
export interface ForgeArtifact {
  readonly brick: BrickArtifact;
  readonly candidateId: string;
  readonly lifecycle: PublishedForgeLifecycleState;
  readonly verification: ForgeVerificationSummary;
  readonly forgedAt: number;
  /** Agent ID that authorized the forge. */
  readonly forgedBy: string;
}

/**
 * `ForgeArtifact` view used inside a `forge_completed` event. The lifecycle
 * is locked to `"published"` because the artifact has just been published —
 * it cannot already be retired in the same event that announces completion.
 * Persisted/replayed artifacts that have since been retired remain valid
 * `ForgeArtifact` values; the distinction lives at the event boundary only.
 */
export interface CompletedForgeArtifact extends Omit<ForgeArtifact, "lifecycle"> {
  readonly lifecycle: "published";
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

const FORGE_LIFECYCLE_VALUES = {
  detected: true,
  proposed: true,
  synthesizing: true,
  verifying: true,
  published: true,
  failed: true,
  retired: true,
} as const satisfies Record<ForgeLifecycleState, true>;

const TERMINAL_FORGE_LIFECYCLE_VALUES = {
  published: true,
  failed: true,
  retired: true,
} as const satisfies Partial<Record<ForgeLifecycleState, true>>;

/** Runtime guard for `ForgeLifecycleState` values. */
export function isForgeLifecycleState(value: string): value is ForgeLifecycleState {
  return Object.hasOwn(FORGE_LIFECYCLE_VALUES, value);
}

/** True when no further transitions are possible. */
export function isTerminalForgeLifecycle(state: ForgeLifecycleState): boolean {
  return Object.hasOwn(TERMINAL_FORGE_LIFECYCLE_VALUES, state);
}

/**
 * Forge stages where failure is possible. Excludes terminal-success states
 * (`published`, `retired`) and the `failed` state itself: a pipeline cannot
 * transition into `failed` *from* a successful or already-failed state.
 */
export type FailableForgeStage = "detected" | "proposed" | "synthesizing" | "verifying";

const FAILABLE_FORGE_STAGE_VALUES = {
  detected: true,
  proposed: true,
  synthesizing: true,
  verifying: true,
} as const satisfies Record<FailableForgeStage, true>;

/** Runtime guard for `FailableForgeStage`. */
export function isFailableForgeStage(value: unknown): value is FailableForgeStage {
  return typeof value === "string" && Object.hasOwn(FAILABLE_FORGE_STAGE_VALUES, value);
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

/**
 * Output contract for forge tools. Discriminated on `ok` so success and
 * failure cannot coexist: a successful result must carry an `artifact` and
 * cannot carry an `error`; a failed result must carry an `error` and cannot
 * carry an `artifact`.
 */
export type ForgeToolResult =
  | {
      readonly ok: true;
      readonly artifact: ForgeArtifact;
      readonly error?: never;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly artifact?: never;
    };

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
      readonly artifact: CompletedForgeArtifact;
    }
  | {
      readonly kind: "forge_failed";
      readonly candidateId: string;
      readonly stage: FailableForgeStage;
      readonly reason: string;
    }
  | {
      readonly kind: "policy_decision";
      readonly candidateId: string;
      readonly verdict: ForgePolicyVerdict;
    };

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOptional<T>(value: unknown, check: (v: unknown) => v is T): boolean {
  return value === undefined || check(value);
}

function isPriority(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

function isNonNegativeTimestamp(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 1;
}

function isCandidateLike(value: unknown): boolean {
  if (!isObject(value)) return false;
  return (
    isString(value.id) &&
    isString(value.kind) &&
    isBrickKind(value.kind) &&
    isString(value.name) &&
    isString(value.description) &&
    isPriority(value.priority) &&
    isForgeScope(value.proposedScope) &&
    isFiniteNumber(value.createdAt) &&
    isOptional(value.demandId, isString)
  );
}

function isDemandLike(value: unknown): boolean {
  if (!isObject(value)) return false;
  const { signal, status, observedAt, occurrences, resolvedAt } = value;
  if (
    !isObject(signal) ||
    !isForgeDemandStatus(status) ||
    !isNonNegativeTimestamp(observedAt) ||
    !isPositiveInteger(occurrences)
  ) {
    return false;
  }
  // Timestamp ordering: a demand cannot be resolved before it was observed.
  if (resolvedAt !== undefined) {
    if (!isNonNegativeTimestamp(resolvedAt) || resolvedAt < observedAt) return false;
  }
  return true;
}

function isArtifactLike(value: unknown): boolean {
  if (!isObject(value)) return false;
  return (
    isObject(value.brick) &&
    isString(value.candidateId) &&
    isPublishedForgeLifecycleState(value.lifecycle) &&
    isObject(value.verification) &&
    isFiniteNumber(value.forgedAt) &&
    isString(value.forgedBy)
  );
}

function isVerdictLike(value: unknown): boolean {
  if (!isObject(value)) return false;
  const decision = value.decision;
  if (decision === "allow") return true;
  if (decision === "require-approval" || decision === "deny") {
    return isString(value.reason);
  }
  return false;
}

/**
 * Runtime guard for `ForgeEvent`. Validates:
 *   - the `kind` discriminant is one of the known event kinds,
 *   - the variant-specific top-level fields are present with the expected
 *     primitive types,
 *   - enum-backed fields owned by this package (`ForgeDemandStatus`,
 *     `ForgeScope`, `BrickKind`, `PublishedForgeLifecycleState`,
 *     `ForgeLifecycleState`, `ForgePolicyVerdict.decision`) match their
 *     declared union members,
 *   - cross-field invariants on `forge_completed` (`artifact.candidateId`
 *     must equal `event.candidateId`).
 *
 * **Not validated**: the inner shape of nested L0 contracts —
 * `BrickArtifact`, `ForgeVerificationSummary`, and `ForgeDemandSignal`. Those
 * have many fields and dedicated owners; deep validation lives with the
 * package that produces or persists them. Treat the guard as a
 * trusted-envelope check, not a deep schema validator.
 */
export function isForgeEvent(value: unknown): value is ForgeEvent {
  if (!isObject(value)) return false;
  const { kind } = value;
  switch (kind) {
    case "demand_detected":
      return isDemandLike(value.demand);
    case "candidate_proposed":
      return isCandidateLike(value.candidate);
    case "synthesize_started":
    case "verify_started":
      return isString(value.candidateId);
    case "forge_completed": {
      const { candidateId, artifact } = value;
      if (!isString(candidateId) || !isArtifactLike(artifact) || !isObject(artifact)) {
        return false;
      }
      // Cross-field invariants:
      //   - the artifact must be attributed to the same candidate the event
      //     names (else observability reducers mis-attribute artifacts), and
      //   - the lifecycle at completion time must be exactly "published". A
      //     `retired` artifact in a `forge_completed` event encodes stale or
      //     out-of-order state and should be rejected at ingress.
      return artifact.candidateId === candidateId && artifact.lifecycle === "published";
    }
    case "forge_failed":
      return (
        isString(value.candidateId) && isFailableForgeStage(value.stage) && isString(value.reason)
      );
    case "policy_decision":
      return isString(value.candidateId) && isVerdictLike(value.verdict);
    default:
      return false;
  }
}
