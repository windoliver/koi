import type {
  CompositionMoment,
  CompositionPlan,
  CompositionStep,
  CompositionTrigger,
} from "./composition-planner.js";

export interface CompositionExecutor {
  readonly execute: (
    trigger: CompositionTrigger,
    plan: CompositionPlan,
  ) => Promise<CompositionExecutionResult>;
}

export interface CompositionExecutionError {
  readonly code: "APPROVAL_REQUIRED" | "STEP_UNSUPPORTED" | "STEP_FAILED" | "INVALID_PLAN";
  readonly message: string;
  readonly stepKind?: CompositionStep["kind"] | undefined;
  /**
   * For STEP_FAILED caused by a `pending` execution-log entry: the derived
   * per-step idempotency key identifying the stuck record. Operators use
   * this to locate the entry and call `executionLog.release(key)` after
   * manually confirming the side effect did not commit.
   */
  readonly idempotencyKey?: string | undefined;
}

type CompositionApprovalRequiredError = CompositionExecutionError & {
  readonly code: "APPROVAL_REQUIRED";
};

type CompositionUnsupportedError = CompositionExecutionError & {
  readonly code: "STEP_UNSUPPORTED" | "INVALID_PLAN";
};

type CompositionFailureError = CompositionExecutionError & {
  readonly code: "STEP_FAILED" | "INVALID_PLAN";
};

interface CompositionStepResultBase {
  readonly step: CompositionStep;
}

type ExecutedCompositionStepResult = CompositionStepResultBase & {
  readonly status: "executed";
  readonly output?: unknown;
  readonly error?: undefined;
};

type SkippedCompositionStepResult = CompositionStepResultBase & {
  readonly status: "skipped";
  readonly output?: undefined;
  readonly error?: undefined;
};

type UnsupportedCompositionStepResult = CompositionStepResultBase & {
  readonly status: "unsupported";
  readonly output?: undefined;
  readonly error: CompositionUnsupportedError;
};

type FailedCompositionStepResult = CompositionStepResultBase & {
  readonly status: "failed";
  readonly output?: undefined;
  readonly error: CompositionFailureError;
};

export type CompositionStepResult =
  | ExecutedCompositionStepResult
  | SkippedCompositionStepResult
  | UnsupportedCompositionStepResult
  | FailedCompositionStepResult;

export type SuccessfulCompositionStepResult =
  | ExecutedCompositionStepResult
  | SkippedCompositionStepResult;

interface CompositionExecutionResultBase<
  TStepResult extends CompositionStepResult = CompositionStepResult,
> {
  readonly triggerId: string;
  readonly stepResults: readonly TStepResult[];
  readonly executedCount: number;
}

// ---------------------------------------------------------------------------
// Pre-commit rejection brand
// ---------------------------------------------------------------------------

/**
 * Symbol used to mark errors thrown by scheduler/notify implementations
 * for failures that are PROVABLY pre-commit (no durable side effect).
 * Composition executors release any reserved execution-log claim when
 * they observe this brand, so a corrected retry can succeed without
 * operator intervention.
 *
 * Keyed via `Symbol.for(...)` so the brand survives module/bundle
 * duplication and realm boundaries — any package can import this
 * constant and produce a recognized rejection without needing a
 * direct dependency between throw-site and check-site.
 *
 * Trust boundary: handlers wired into the executor (scheduler, notify,
 * spawn, forge, toolCall) are TRUSTED code chosen by the host. They
 * already have full access to `preCommitRejection()` via this module, so
 * "forging" the brand is equivalent to calling the factory — no privilege
 * escalation. The brand exists to distinguish deliberate
 * `throw preCommitRejection(...)` from accidental `throw new Error(...)`,
 * not to defend against adversarial in-process callers. Hosts MUST treat
 * handler wiring as a trusted-configuration boundary.
 */
export const COMPOSITION_PRE_COMMIT_BRAND_KEY = "@koi/proactive/preCommitRejection" as const;
export const COMPOSITION_PRE_COMMIT_BRAND: unique symbol = Symbol.for(
  COMPOSITION_PRE_COMMIT_BRAND_KEY,
) as never;

export interface CompositionPreCommitRejection extends Error {
  readonly [COMPOSITION_PRE_COMMIT_BRAND]: true;
}

export function preCommitRejection(
  message: string,
  cause?: unknown,
): CompositionPreCommitRejection {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  Object.defineProperty(error, COMPOSITION_PRE_COMMIT_BRAND, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return error as CompositionPreCommitRejection;
}

export function isPreCommitRejection(value: unknown): value is CompositionPreCommitRejection {
  // Detect the brand structurally, not via `instanceof Error`. Errors
  // crossing realm/bundle boundaries can fail same-realm Error identity
  // even when they carry the shared Symbol.for() brand. The brand is
  // unforgeable enough to rely on alone — synthesizing it requires an
  // explicit `Symbol.for(COMPOSITION_PRE_COMMIT_BRAND_KEY)` lookup.
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  return (
    (value as { [COMPOSITION_PRE_COMMIT_BRAND]?: unknown })[COMPOSITION_PRE_COMMIT_BRAND] === true
  );
}

// ---------------------------------------------------------------------------
// Composition gap — emitted when the executor cannot dispatch a step because
// the host has not wired a handler for that step kind. Forms the basis of the
// pull-based ForgeDemand feedback loop: each gap names the missing capability
// and the trigger context that surfaced it.
// ---------------------------------------------------------------------------

export interface CompositionGap {
  readonly triggerId: string;
  readonly moment: CompositionMoment;
  readonly missingCapabilities: readonly string[];
  readonly firstSeen: number;
  readonly lastSeen: number;
  readonly frequency: number;
}

export type CompositionExecutionResult =
  | (CompositionExecutionResultBase<SuccessfulCompositionStepResult> & {
      readonly status: "executed";
      readonly error?: undefined;
    })
  | {
      readonly triggerId: string;
      readonly status: "requires_approval";
      readonly stepResults: readonly [];
      readonly executedCount: 0;
      readonly error: CompositionApprovalRequiredError;
    }
  | (CompositionExecutionResultBase & {
      readonly status: "unsupported";
      readonly error: CompositionUnsupportedError;
    })
  | (CompositionExecutionResultBase & {
      readonly status: "failed";
      readonly error: CompositionFailureError;
    });
