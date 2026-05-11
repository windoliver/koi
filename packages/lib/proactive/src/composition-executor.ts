import { createHash } from "node:crypto";
import {
  type AgentId,
  type CompositionExecutionError,
  type CompositionExecutionResult,
  type CompositionExecutor,
  type CompositionPlan,
  type CompositionPreCommitRejection,
  type CompositionStep,
  type CompositionStepResult,
  type CompositionTrigger,
  type DeliveryPolicy,
  type EngineInput,
  type ForgeDemandSignal,
  isPreCommitRejection,
  preCommitRejection,
  type SchedulerComponent,
} from "@koi/core";
import type { CompositionCheckpointStore } from "./composition-checkpoint-store.js";
import {
  type CompositionGovernance,
  defaultPatternKey,
  evaluateCompositionGate,
  inferCompositionGap,
  type NoveltyTracker,
  type OutcomeRecorder,
  type SessionRateTracker,
} from "./composition-governance.js";

export type { CompositionPreCommitRejection };
// Re-export the L0 brand surface so consumers of @koi/proactive that
// already import from this package continue to work; the canonical
// definition now lives in @koi/core so any package can opt into the
// contract without an L2-to-L2 import.
export { isPreCommitRejection, preCommitRejection };

export interface CompositionNotification {
  readonly channel: string;
  readonly message: string;
  readonly priority: "low" | "normal" | "high";
  /**
   * Deterministic per-step key. Adapters that support dedupe SHOULD drop
   * duplicate deliveries with the same key. Optional for source compatibility
   * with adapters that pre-date dedupe support.
   */
  readonly idempotencyKey?: string | undefined;
}

export interface CompositionSpawnRequest {
  readonly agentType: string;
  readonly input: EngineInput;
  readonly delivery: DeliveryPolicy;
}

export interface CompositionForgeRequest {
  readonly demand: ForgeDemandSignal;
}

export interface CompositionToolCallRequest {
  readonly toolName: string;
  readonly input: unknown;
  readonly idempotencyKey: string;
}

export type CompositionExecutionStatus =
  | { readonly kind: "claimed" }
  | { readonly kind: "pending" }
  | { readonly kind: "complete"; readonly output: unknown };

/**
 * Persisted record of step executions, keyed by deterministic step idempotency
 * key. Three-call atomic contract for irreversible side effects (notably
 * `create_schedule` and `notify_user`):
 *
 *   1. `claim(key)` — atomic compare-and-set. Returns:
 *        - `{ kind: "claimed" }`: caller is the unique winner; proceed with
 *          the side effect, then call `record()`.
 *        - `{ kind: "pending" }`: a prior attempt reserved this key but never
 *          finalized; fail closed (re-running risks duplicate side effects).
 *        - `{ kind: "complete", output }`: side effect already happened;
 *          short-circuit with the recorded output.
 *      Implementations MUST make this single call atomic across concurrent
 *      callers (e.g. row-level UPSERT, Redis SETNX, or in-process Map check).
 *
 *   2. `record(key, output)` — finalize after the side effect succeeds.
 *      record() is idempotent: it overwrites whatever entry currently
 *      exists (absent, pending, or complete). After a transient record()
 *      outage, an operator that has externally confirmed the side effect
 *      committed can re-call `record(key, output)` to recover the stuck
 *      "pending" state without re-running the side effect.
 *
 *   3. `release(key)` — drop the claim. The executor calls this when a
 *      step throws `preCommitRejection(...)` (proven pre-commit failure).
 *      Operators also call it manually after confirming a "pending" entry
 *      did NOT commit its side effect.
 */
export interface CompositionExecutionLog {
  readonly claim: (key: string) => CompositionExecutionStatus | Promise<CompositionExecutionStatus>;
  readonly record: (key: string, output: unknown) => void | Promise<void>;
  readonly release: (key: string) => void | Promise<void>;
}

export interface CompositionExecutionContext {
  readonly agentId: AgentId;
  /**
   * Scheduler used for `submit_task` and `create_schedule`. Implementations
   * SHOULD throw `preCommitRejection(...)` (from this package) for any
   * deterministic, no-side-effect failure (invalid cron expression, invalid
   * input, unsupported option, etc.) so the executor releases the
   * execution-log claim and a corrected retry can succeed without operator
   * intervention. Plain `Error` throws are treated as ambiguous (claim left
   * pending, idempotencyKey surfaced for reconciliation) since the
   * executor cannot tell whether a side effect committed.
   */
  readonly scheduler: SchedulerComponent;
  /**
   * User-notification dispatch. Implementations SHOULD throw
   * `preCommitRejection(...)` for deterministic pre-send failures (invalid
   * payload, local config error, unauthorized channel) so the executor
   * releases the claim. Plain `Error` throws are ambiguous and leave the
   * claim pending — see `executionLog` semantics for reconciliation.
   */
  readonly notify: (notification: CompositionNotification) => Promise<unknown>;
  /**
   * Optional handler for `spawn_agent` steps. When provided, the executor
   * routes spawn_agent through the same executionLog claim/record path used
   * for create_schedule and notify_user — including pre-commit rejection
   * release. When omitted, spawn_agent steps return `unsupported` (existing
   * fail-closed behavior).
   */
  readonly spawn?:
    | ((request: CompositionSpawnRequest & { readonly idempotencyKey: string }) => Promise<unknown>)
    | undefined;
  /**
   * Optional handler for `forge_skill` steps. Same executionLog semantics as
   * `spawn`. Omitted → `unsupported`.
   */
  readonly forge?:
    | ((request: CompositionForgeRequest & { readonly idempotencyKey: string }) => Promise<unknown>)
    | undefined;
  /**
   * Optional handler for `tool_call` steps. Same executionLog semantics as
   * `spawn`. Omitted → `unsupported`.
   */
  readonly toolCall?: ((request: CompositionToolCallRequest) => Promise<unknown>) | undefined;
  /**
   * MANDATORY. Required to execute `create_schedule` and `notify_user`
   * safely. Required at the type boundary so callers cannot accidentally
   * skip retry-safety: neither step kind has native dedupe (scheduler.schedule
   * rejects idempotencyKey; notification adapters are best-effort), and an
   * ambiguous retry would otherwise register a duplicate cron schedule or
   * send a duplicate user notification.
   */
  readonly executionLog: CompositionExecutionLog;
  /**
   * Allowlist of channel names the executor will dispatch `notify_user`
   * steps to. Channels outside this set are rejected as INVALID_PLAN
   * BEFORE the execution-log claim, so a planner-controlled (LLM) channel
   * string cannot route operator-facing messages to unintended
   * destinations. Defaults to `["inbox"]` for the MVP — hosts that wire
   * `notify` to additional channels MUST opt those channels in explicitly.
   */
  readonly allowedNotifyChannels?: readonly string[] | undefined;
  /**
   * Allowlist of tool names the executor will dispatch `tool_call` steps
   * to. When provided, a step whose `toolName` is outside this set is
   * rejected as INVALID_PLAN BEFORE the execution-log claim and BEFORE
   * the toolCall handler is invoked — so a planner-controlled (LLM)
   * tool name cannot reach a host that wires a permissive resolver.
   * Omitted → the wired `toolCall` handler is the only authorization.
   */
  readonly allowedToolNames?: readonly string[] | undefined;
  /**
   * Allowlist of agent types the executor will dispatch `spawn_agent`
   * steps to. Same semantics as `allowedToolNames`. Omitted → the wired
   * `spawn` handler is the only authorization.
   */
  readonly allowedAgentTypes?: readonly string[] | undefined;
  /**
   * Allowlist of brick kinds the executor will accept for `forge_skill`
   * steps (matched against `step.demand.suggestedBrickKind`). Same
   * semantics as `allowedToolNames`. Omitted → the wired `forge` handler
   * is the only authorization.
   */
  readonly allowedForgeBrickKinds?: readonly string[] | undefined;
  /**
   * Optional governance config — confidence/budget/delegation/rate-limit/
   * novelty checks. When provided, the executor evaluates the gate before
   * dispatching steps and returns `requires_approval` (with the failing
   * reason in the error message) if any check denies the plan. Omitted →
   * the existing `plan.requiresApproval` boolean is the only gate.
   */
  readonly governance?: CompositionGovernance | undefined;
  /**
   * Per-session rate-limit tracker. Wired together with `sessionId` so the
   * gate can refuse runaway plans within a single session window. Without
   * both, the rate-limit component of the gate is skipped.
   */
  readonly sessionRate?: SessionRateTracker | undefined;
  readonly sessionId?: string | undefined;
  /**
   * Pattern-novelty tracker. Counts successful executions per pattern key
   * (default: `${trigger.source}|${trigger.moment.kind}`) so the
   * novel-pattern guard can auto-approve once a pattern has succeeded N
   * times. Without it, novelty gating is skipped.
   */
  readonly novelty?: NoveltyTracker | undefined;
  /**
   * Optional outcome sink — receives every execute() result for downstream
   * recording (ACE trajectory, collective memory, observability) and
   * receives a CompositionGap for each step the executor surfaces as
   * unsupported (capability-gap → ForgeDemand candidate).
   */
  readonly outcomeRecorder?: OutcomeRecorder | undefined;
  /** Clock override; defaults to `Date.now`. Used for CompositionGap timestamps. */
  readonly now?: (() => number) | undefined;
  /**
   * Optional checkpoint store for per-plan progress observability. When
   * wired together with `executionId`, the executor emits a snapshot after
   * each successful step, deletes on terminal success, and persists a
   * `phase: "failed"` snapshot on terminal failure / unsupported. Snapshots
   * are observability-only — store failures are swallowed and the
   * executionLog remains the correctness source of truth for did-this-side-
   * effect-already-commit. Hosts use the snapshot stream to enumerate
   * in-flight executions on restart; the actual resume mechanism is the
   * mandatory executionLog's claim/record/release contract.
   */
  readonly checkpointStore?: CompositionCheckpointStore | undefined;
  /**
   * Stable per-execution identifier. Required when `checkpointStore` is
   * provided. Hosts typically derive this from
   * `${agentId}:${trigger.id}:${trigger.emittedAt}` or from a workflow ID
   * for Temporal-backed deployments. Without `checkpointStore`, this field
   * is ignored. With `checkpointStore` and missing/empty `executionId`,
   * execute() returns INVALID_PLAN immediately.
   */
  readonly executionId?: string | undefined;
  /**
   * Plan-stable hash override. Defaults to a SHA-256 of the canonicalized
   * plan (field-order independent). Used as the `planHash` field of every
   * emitted snapshot so hosts can detect plan drift between attempts.
   */
  readonly hashPlan?: ((plan: CompositionPlan) => string) | undefined;
}

function defaultPlanHash(plan: CompositionPlan): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(plan)))
    .digest("hex");
}

const DEFAULT_ALLOWED_NOTIFY_CHANNELS: readonly string[] = ["inbox"];

type ExecutedStepResult = Extract<CompositionStepResult, { status: "executed" }>;

// Brand definitions live in @koi/core (re-exported above). Scheduler/notify
// implementations across any package can `throw preCommitRejection(...)`
// for proven pre-commit failures so the executor releases its claim and
// callers retry without operator intervention.

/**
 * Process-local CompositionExecutionLog backed by a Map. Suitable for
 * single-process callers and tests. Not durable across restarts —
 * production deployments need a persistent backend (SQLite, Redis,
 * Postgres) so retries after a crash still see prior claims/records.
 */
export function inMemoryCompositionExecutionLog(): CompositionExecutionLog {
  const store = new Map<string, { kind: "pending" } | { kind: "complete"; output: unknown }>();
  return {
    claim: (key) => {
      const existing = store.get(key);
      if (existing) return existing;
      store.set(key, { kind: "pending" });
      return { kind: "claimed" };
    },
    record: (key, output) => {
      store.set(key, { kind: "complete", output });
    },
    release: (key) => {
      store.delete(key);
    },
  };
}

// Stable JSON: object keys sorted recursively so logically equal payloads
// always serialize to the same string (independent of insertion order).
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = canonicalize(v);
    return out;
  }
  return value;
}

// Strip planner-supplied `taskOptions.idempotencyKey` from a step before
// hashing — it's intentionally ignored at dispatch (the executor always
// uses its own derived key), so two otherwise-identical steps that differ
// only in this field MUST hash to the same dedupe key. When stripping
// leaves taskOptions empty, drop the field entirely so a step with no
// taskOptions at all hashes the same as one whose taskOptions only
// contained the ignored key.
function stripIgnoredFields(step: CompositionStep): CompositionStep {
  if (
    (step.kind === "submit_task" || step.kind === "create_schedule") &&
    step.taskOptions?.idempotencyKey !== undefined
  ) {
    const { idempotencyKey: _ignored, ...rest } = step.taskOptions;
    if (Object.keys(rest).length === 0) {
      const { taskOptions: _dropped, ...withoutOptions } = step;
      return withoutOptions as CompositionStep;
    }
    return { ...step, taskOptions: rest };
  }
  return step;
}

// Canonical-content fingerprint for a step (cached per plan via the occurrence
// counter below — avoids re-canonicalizing identical steps).
function stepFingerprint(step: CompositionStep): string {
  return JSON.stringify(canonicalize(stripIgnoredFields(step)));
}

// Per-step idempotency key. Hash-based and ':' free so it is accepted by
// scheduler backends that use ':' as their internal task-ID delimiter
// (e.g. the Temporal scheduler). Hashes trigger id + emittedAt +
// occurrenceIndex + canonicalized step payload.
//
// `emittedAt` distinguishes distinct emissions of triggers that may share an
// `id` (the public CompositionTrigger contract does not require id uniqueness
// across emissions).
//
// `occurrenceIndex` is the count of prior steps in the same plan with
// identical canonicalized content. It is NOT the array ordinal — it stays
// stable when unrelated steps are reordered or inserted in a re-plan, so
// already-committed steps short-circuit via the execution log. But it
// distinguishes two semantically identical steps in the same plan so they
// each fire (rather than collapsing into one).
function deriveStepIdempotencyKey(
  agentId: AgentId,
  trigger: CompositionTrigger,
  occurrenceIndex: number,
  step: CompositionStep,
): string {
  // agentId is folded into the hash so two different agents handling the
  // same trigger never collide on a shared executionLog backend. submit_task
  // and create_schedule already carry agentId on the step, but notify_user
  // does not — without this, two agents notifying the same user about the
  // same trigger emission would dedupe to a single delivery.
  const hasher = createHash("sha256");
  hasher.update(
    JSON.stringify({
      agentId: String(agentId),
      triggerId: trigger.id,
      emittedAt: trigger.emittedAt,
      occurrenceIndex,
      step: canonicalize(stripIgnoredFields(step)),
    }),
  );
  return `cmp-${hasher.digest("hex").slice(0, 32)}`;
}

// Cheap pre-commit syntactic check. Intentionally permissive: it only
// catches obviously-malformed inputs (empty strings, free-text, wrong
// field count) so the real backend cron parser remains the source of
// truth. Allowed charset includes letters so named day/month tokens
// (MON-SUN, JAN-DEC) used by `croner` and most cron flavours pass through.
// Fuller semantic validation still happens inside scheduler.schedule().
const CRON_FIELD_CHARS = /^[A-Za-z\d*?\-,/#]+$/;
function malformedCronExpression(expression: string): string | undefined {
  if (typeof expression !== "string" || expression.trim().length === 0) {
    return "expression must be a non-empty string";
  }
  const fields = expression.trim().split(/\s+/u);
  if (fields.length < 5 || fields.length > 6) {
    return `expression must have 5 or 6 fields (got ${fields.length})`;
  }
  for (const field of fields) {
    if (!CRON_FIELD_CHARS.test(field)) {
      return `field "${field}" contains characters not allowed in a cron expression`;
    }
  }
  return undefined;
}

function approvalRequired(
  trigger: CompositionTrigger,
  reason?: string,
): CompositionExecutionResult {
  return {
    triggerId: trigger.id,
    status: "requires_approval",
    stepResults: [],
    executedCount: 0,
    error: {
      code: "APPROVAL_REQUIRED",
      message:
        reason === undefined
          ? "Composition plan requires approval before execution."
          : `Composition plan requires approval: ${reason}`,
    },
  };
}

function invalidTriggerPlanError(
  trigger: CompositionTrigger,
  plan: CompositionPlan,
): CompositionExecutionError & { readonly code: "INVALID_PLAN" } {
  return {
    code: "INVALID_PLAN",
    message: `plan triggerId ${plan.triggerId} does not match execute trigger ${trigger.id}`,
  };
}

function invalidPlanError(
  step: Extract<CompositionStep, { kind: "submit_task" | "create_schedule" }>,
  agentId: AgentId,
): CompositionExecutionError & { readonly code: "INVALID_PLAN" } {
  return {
    code: "INVALID_PLAN",
    message: `${step.kind} agentId ${String(step.agentId)} does not match attached agent ${String(agentId)}`,
    stepKind: step.kind,
  };
}

function stepUnsupported(
  step: Extract<CompositionStep, { kind: "spawn_agent" | "forge_skill" | "tool_call" }>,
): Extract<CompositionStepResult, { status: "unsupported" }> {
  return {
    step,
    status: "unsupported",
    error: {
      code: "STEP_UNSUPPORTED",
      message: `Unsupported composition step: ${step.kind}`,
      stepKind: step.kind,
    },
  };
}

function stepFailed(
  step: CompositionStep,
  cause: unknown,
  idempotencyKey?: string,
): Extract<CompositionStepResult, { status: "failed" }> {
  const message = cause instanceof Error ? cause.message : String(cause);
  return {
    step,
    status: "failed",
    error: {
      code: "STEP_FAILED",
      message,
      stepKind: step.kind,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    },
  };
}

function failedResult(
  triggerId: string,
  prior: readonly ExecutedStepResult[],
  failure: Extract<CompositionStepResult, { status: "failed" }>,
): CompositionExecutionResult {
  return {
    triggerId,
    status: "failed",
    stepResults: [...prior, failure],
    executedCount: prior.length,
    error: failure.error,
  };
}

function unsupportedResult(
  triggerId: string,
  prior: readonly ExecutedStepResult[],
  unsupported: Extract<CompositionStepResult, { status: "unsupported" }>,
): CompositionExecutionResult {
  return {
    triggerId,
    status: "unsupported",
    stepResults: [...prior, unsupported],
    executedCount: prior.length,
    error: unsupported.error,
  };
}

export function createCompositionExecutor(
  context: CompositionExecutionContext,
): CompositionExecutor {
  const now = context.now ?? Date.now;
  const recorder = context.outcomeRecorder;
  const checkpointStore = context.checkpointStore;
  const executionId = context.executionId;
  const hashPlan = context.hashPlan ?? defaultPlanHash;
  // Validate at executor construction: wiring a store without an id is a
  // host configuration bug. Defer the surfaced error until execute() runs
  // so the contract (every call resolves to a structured result) holds.
  const missingExecutionId =
    checkpointStore !== undefined && (executionId === undefined || executionId === "");

  async function saveProgress(
    plan: CompositionPlan,
    stepResults: readonly ExecutedStepResult[],
    phase: "in_progress" | "failed",
  ): Promise<void> {
    if (checkpointStore === undefined || executionId === undefined || executionId === "") return;
    try {
      await checkpointStore.save({
        executionId,
        planHash: hashPlan(plan),
        nextStepIndex: stepResults.length,
        stepResults: stepResults.map((r) => r.output),
        phase,
        savedAt: now(),
      });
    } catch {
      // Snapshot persistence is observability-only. A non-serializable
      // step output, a backing-store write failure, or a hashPlan throw
      // must never convert a structured executor result into an uncaught
      // throw.
    }
  }

  async function deleteProgress(): Promise<void> {
    if (checkpointStore === undefined || executionId === undefined || executionId === "") return;
    try {
      await checkpointStore.delete(executionId);
    } catch {
      // Same rationale as saveProgress — cleanup failure is observability-only.
    }
  }

  async function emitGap(trigger: CompositionTrigger, step: CompositionStep): Promise<void> {
    if (recorder?.recordGap === undefined) return;
    try {
      await recorder.recordGap(inferCompositionGap({ trigger, step, now: now() }));
    } catch {
      // Recorder failures must not turn a structured executor result into
      // an uncaught throw. Drop silently — observability is best-effort.
    }
  }

  async function finalize(
    trigger: CompositionTrigger,
    plan: CompositionPlan,
    result: CompositionExecutionResult,
    committedNewWork: boolean,
    acquiredSessionSlot: boolean,
  ): Promise<CompositionExecutionResult> {
    // Any execution that committed at least one fresh side effect must
    // consume session/novelty budget — even if a LATER step failed or
    // was unsupported. Otherwise a plan like [notify_user, fail_step]
    // could repeatedly emit notifications without ever touching the
    // session cap. Pure replay-only runs (every step short-circuited
    // via executionLog complete) still skip the bookkeeping.
    const committedFreshSideEffect = committedNewWork;

    // Atomic-acquire path: when the gate consumed a slot via tryAcquire,
    // release it ONLY on pure replay (no fresh side effect at all). Partial
    // commits keep the slot — the host still saw real autonomous work,
    // even though a later step failed. The non-atomic fallback path was
    // removed because it raced under concurrent execute() calls; the gate
    // now fails closed when tryAcquire is missing.
    if (
      acquiredSessionSlot &&
      !committedFreshSideEffect &&
      context.sessionId !== undefined &&
      context.sessionRate?.release !== undefined
    ) {
      try {
        await context.sessionRate.release(context.sessionId);
      } catch {
        /* release failure is observability-only */
      }
    }
    // Novelty credit is stricter than session-rate accounting: only fully
    // successful executions count toward auto-approval. Partial commits
    // (notify_user followed by an unsupported step, etc.) still load the
    // session budget — they really happened — but they do not "validate"
    // the pattern, since the operator never saw the full intended
    // automation succeed end-to-end.
    const fullySuccessful = result.status === "executed" && committedNewWork;
    if (fullySuccessful && context.governance !== undefined && context.novelty !== undefined) {
      const keyFn = context.governance.patternKey ?? defaultPatternKey;
      try {
        await context.novelty.recordSuccess(keyFn(trigger, plan, context.agentId));
      } catch {
        /* tracker hiccups must not invalidate a successful execution */
      }
    }
    if (recorder?.record !== undefined) {
      try {
        await recorder.record(trigger, plan, result);
      } catch {
        /* recorder failures are observability-only */
      }
    }
    return result;
  }

  async function runPlan(
    trigger: CompositionTrigger,
    plan: CompositionPlan,
    state: { committedNewWork: boolean; acquiredSessionSlot: boolean },
  ): Promise<CompositionExecutionResult> {
    if (plan.triggerId !== trigger.id) {
      return {
        triggerId: trigger.id,
        status: "failed",
        stepResults: [],
        executedCount: 0,
        error: invalidTriggerPlanError(trigger, plan),
      };
    }

    // Bind plan to the exact trigger emission, not just `trigger.id`.
    // Trigger ids are not guaranteed unique across emissions, so a
    // stale plan from emission A could otherwise execute against
    // emission B. `triggerEmittedAt` is required by the L0
    // CompositionPlan contract.
    if (plan.triggerEmittedAt !== trigger.emittedAt) {
      return {
        triggerId: trigger.id,
        status: "failed",
        stepResults: [],
        executedCount: 0,
        error: {
          code: "INVALID_PLAN",
          message:
            `plan.triggerEmittedAt ${plan.triggerEmittedAt} does not match ` +
            `trigger.emittedAt ${trigger.emittedAt} (stale plan for reused trigger id)`,
        },
      };
    }

    // CompositionGap is emitted ONLY from real execution attempts (in the
    // step loop below). Pre-emitting gaps for approval-gated or
    // governance-denied plans would let unapproved planner-authored
    // payloads (especially LLM plans) mutate the capability-feedback /
    // ForgeDemand pipeline without a human ever validating them. Hosts
    // that want gap telemetry from denied plans should scan plans
    // themselves in a separate OutcomeRecorder hook.
    if (plan.requiresApproval) return approvalRequired(trigger);

    // 5-component governance gate (confidence/budget/delegation/rate-limit/
    // novelty). Runs AFTER the basic plan-validity checks so they always
    // win, but BEFORE step dispatch so a denied plan never commits side
    // effects. Skipped entirely when no governance config is wired.
    if (context.governance !== undefined) {
      // Backend failures (delegationCheck / tryAcquire / successCount
      // throwing) are converted to a structured `failed` result so
      // execute() always resolves to a CompositionExecutionResult — never
      // rejects. If a session slot was acquired before the throw, attempt
      // best-effort release here so the quota isn't permanently burned.
      let decision: Awaited<ReturnType<typeof evaluateCompositionGate>>;
      try {
        decision = await evaluateCompositionGate({
          trigger,
          plan,
          agentId: context.agentId,
          governance: context.governance,
          sessionId: context.sessionId,
          sessionRate: context.sessionRate,
          novelty: context.novelty,
        });
      } catch (cause) {
        if (context.sessionId !== undefined && context.sessionRate?.release !== undefined) {
          try {
            await context.sessionRate.release(context.sessionId);
          } catch {
            /* release failure is observability-only */
          }
        }
        return {
          triggerId: trigger.id,
          status: "failed",
          stepResults: [],
          executedCount: 0,
          error: {
            code: "STEP_FAILED",
            message: `governance evaluation threw: ${cause instanceof Error ? cause.message : String(cause)}`,
          },
        };
      }
      if (!decision.allowed) return approvalRequired(trigger, decision.reason);
      state.acquiredSessionSlot = decision.acquiredSessionSlot;
    }

    // Empty non-approval plans are almost always a planner bug — silently
    // succeeding would drop the trigger without any visible action. Fail
    // closed as INVALID_PLAN so the caller can re-plan or escalate.
    if (plan.steps.length === 0) {
      return {
        triggerId: trigger.id,
        status: "failed",
        stepResults: [],
        executedCount: 0,
        error: {
          code: "INVALID_PLAN",
          message: "plan has zero steps; refusing to silently succeed on an empty plan",
        },
      };
    }

    const allowedChannels = context.allowedNotifyChannels ?? DEFAULT_ALLOWED_NOTIFY_CHANNELS;

    const stepResults: ExecutedStepResult[] = [];

    // Per-content occurrence counter — the Nth identical step in a plan
    // gets occurrenceIndex N. Stable across reorders of unrelated steps.
    const occurrenceCounts = new Map<string, number>();

    for (let index = 0; index < plan.steps.length; index += 1) {
      const step = plan.steps[index]!;
      // Fingerprint + key derivation walks the step payload, so a
      // circular reference, throwing getter, or other non-serializable
      // value would crash execute() before the fail-closed path runs.
      // Wrap as INVALID_PLAN so the contract holds: every execute()
      // call resolves to a structured result.
      let fingerprint: string;
      let stepIdempotencyKey: string;
      try {
        fingerprint = stepFingerprint(step);
        stepIdempotencyKey = deriveStepIdempotencyKey(
          context.agentId,
          trigger,
          occurrenceCounts.get(fingerprint) ?? 0,
          step,
        );
      } catch (cause) {
        return failedResult(trigger.id, stepResults, {
          step,
          status: "failed",
          error: {
            code: "INVALID_PLAN",
            message: `step payload could not be canonicalized: ${cause instanceof Error ? cause.message : String(cause)}`,
            stepKind: step.kind,
          },
        });
      }
      const occurrenceIndex = occurrenceCounts.get(fingerprint) ?? 0;
      occurrenceCounts.set(fingerprint, occurrenceIndex + 1);
      // Track whether this step has acquired the executionLog claim so the
      // outer catch can release on pre-commit rejection or surface the key
      // on ambiguous failure. Only set after claim() returns "claimed".
      let claimedKey: string | undefined;
      try {
        switch (step.kind) {
          case "submit_task": {
            if (step.agentId !== context.agentId) {
              return failedResult(trigger.id, stepResults, {
                step,
                status: "failed",
                error: invalidPlanError(step, context.agentId),
              });
            }

            // Always use the executor-derived key, even if the planner
            // provided one. Trusting planner keys would let a buggy or
            // adversarial plan reuse the same key across distinct steps
            // and cause the scheduler to silently drop later submissions
            // as duplicates. If a planner needs to influence dedupe, it
            // should do so via the canonicalized step content (which
            // already feeds `stepIdempotencyKey`).
            //
            // submit_task goes through the same atomic executionLog
            // claim/record path as create_schedule and notify_user.
            // scheduler.submit() backends are not all required to honor
            // idempotencyKey natively (the in-process heap-backed
            // scheduler ignores it), so the executionLog is the
            // universal source of truth for "did this side effect
            // already happen?".
            const claimSubmit = await context.executionLog.claim(stepIdempotencyKey);
            if (claimSubmit.kind === "complete") {
              stepResults.push({ step, status: "executed", output: claimSubmit.output });
              break;
            }
            if (claimSubmit.kind === "pending") {
              return failedResult(trigger.id, stepResults, {
                step,
                status: "failed",
                error: {
                  code: "STEP_FAILED",
                  message:
                    "Previous submit_task attempt is in indeterminate state " +
                    `(claimed but not finalized); manual reconciliation required for key ${stepIdempotencyKey}`,
                  stepKind: "submit_task",
                  idempotencyKey: stepIdempotencyKey,
                },
              });
            }

            claimedKey = stepIdempotencyKey;

            const { idempotencyKey: _ignored, ...submitOptions } = step.taskOptions ?? {};
            const output = await context.scheduler.submit(step.input, step.mode, {
              ...submitOptions,
              idempotencyKey: stepIdempotencyKey,
            });
            state.committedNewWork = true;

            await context.executionLog.record(stepIdempotencyKey, output);
            stepResults.push({ step, status: "executed", output });
            break;
          }

          case "create_schedule": {
            if (step.agentId !== context.agentId) {
              return failedResult(trigger.id, stepResults, {
                step,
                status: "failed",
                error: invalidPlanError(step, context.agentId),
              });
            }

            // Cheap cron syntax pre-check before claim so an obviously
            // malformed expression surfaces as INVALID_PLAN (re-plannable)
            // instead of wedging the execution log on a deterministic
            // scheduler.schedule() throw.
            const cronError = malformedCronExpression(step.expression);
            if (cronError !== undefined) {
              return failedResult(trigger.id, stepResults, {
                step,
                status: "failed",
                error: {
                  code: "INVALID_PLAN",
                  message: `create_schedule expression "${step.expression}" is malformed: ${cronError}`,
                  stepKind: "create_schedule",
                },
              });
            }

            // Replay safety: scheduler.schedule() has no native dedupe and
            // the Temporal backend explicitly rejects idempotencyKey. The
            // mandatory executionLog enforces single-fire across retries.
            const claim = await context.executionLog.claim(stepIdempotencyKey);
            if (claim.kind === "complete") {
              stepResults.push({ step, status: "executed", output: claim.output });
              break;
            }
            if (claim.kind === "pending") {
              // Prior attempt reached scheduler.schedule() but never
              // finalized — the schedule may or may not have been created.
              // Fail closed: a retry could register a duplicate.
              return failedResult(trigger.id, stepResults, {
                step,
                status: "failed",
                error: {
                  code: "STEP_FAILED",
                  message:
                    "Previous create_schedule attempt is in indeterminate state " +
                    `(claimed but not finalized); manual reconciliation required for key ${stepIdempotencyKey}`,
                  stepKind: "create_schedule",
                  idempotencyKey: stepIdempotencyKey,
                },
              });
            }

            claimedKey = stepIdempotencyKey;

            // Forward all taskOptions plus optional timezone to the
            // scheduler. Backend-specific option support is the
            // scheduler's responsibility: implementations that cannot
            // honor a given option MUST throw `preCommitRejection(...)`
            // (no side effect committed) so the executor releases the
            // claim and the caller can retry with corrected input.
            // Plain `Error` throws remain ambiguous and leave the claim
            // pending for operator reconciliation.
            // Strip planner-supplied idempotencyKey: scheduler.schedule()
            // backends do not accept it (Temporal rejects it synchronously)
            // and the executor's executionLog is the universal source of
            // truth for dedupe — mirrors the same handling in submit_task.
            const { idempotencyKey: _ignoredScheduleKey, ...scheduleTaskOptions } =
              step.taskOptions ?? {};
            const scheduleOptions: Record<string, unknown> = {
              ...scheduleTaskOptions,
              ...(step.timezone === undefined ? {} : { timezone: step.timezone }),
            };
            const output = await context.scheduler.schedule(
              step.expression,
              step.input,
              step.mode,
              Object.keys(scheduleOptions).length === 0
                ? undefined
                : (scheduleOptions as Parameters<typeof context.scheduler.schedule>[3]),
            );
            state.committedNewWork = true;

            await context.executionLog.record(stepIdempotencyKey, output);
            stepResults.push({ step, status: "executed", output });
            break;
          }

          case "notify_user": {
            // Channel allowlist: reject planner-controlled (LLM) channel
            // strings outside the host-approved set BEFORE claiming the
            // execution-log key, so a malformed plan is re-plannable
            // without operator intervention.
            if (!allowedChannels.includes(step.channel)) {
              return failedResult(trigger.id, stepResults, {
                step,
                status: "failed",
                error: {
                  code: "INVALID_PLAN",
                  message: `notify_user channel "${step.channel}" is not in the allowlist [${allowedChannels.join(", ")}]`,
                  stepKind: "notify_user",
                },
              });
            }

            // Notification adapters are best-effort on dedupe, so the
            // executor enforces replay safety via the same atomic claim
            // path as create_schedule.
            const claim = await context.executionLog.claim(stepIdempotencyKey);
            if (claim.kind === "complete") {
              stepResults.push({ step, status: "executed", output: claim.output });
              break;
            }
            if (claim.kind === "pending") {
              return failedResult(trigger.id, stepResults, {
                step,
                status: "failed",
                error: {
                  code: "STEP_FAILED",
                  message:
                    "Previous notify_user attempt is in indeterminate state " +
                    `(claimed but not finalized); manual reconciliation required for key ${stepIdempotencyKey}`,
                  stepKind: "notify_user",
                  idempotencyKey: stepIdempotencyKey,
                },
              });
            }

            claimedKey = stepIdempotencyKey;

            // Same release rules as create_schedule: pre-commit rejections
            // release the claim; other throws leave it pending and surface
            // the key, since the notification may have been delivered.
            const notifyOutput = await context.notify({
              channel: step.channel,
              message: step.message,
              priority: step.priority,
              idempotencyKey: stepIdempotencyKey,
            });
            state.committedNewWork = true;

            await context.executionLog.record(stepIdempotencyKey, notifyOutput);
            stepResults.push({ step, status: "executed", output: notifyOutput });
            break;
          }

          case "spawn_agent": {
            if (context.spawn === undefined) {
              await emitGap(trigger, step);
              return unsupportedResult(trigger.id, stepResults, stepUnsupported(step));
            }
            if (
              context.allowedAgentTypes !== undefined &&
              !context.allowedAgentTypes.includes(step.agentType)
            ) {
              return failedResult(trigger.id, stepResults, {
                step,
                status: "failed",
                error: {
                  code: "INVALID_PLAN",
                  message: `spawn_agent agentType "${step.agentType}" is not in the allowlist [${context.allowedAgentTypes.join(", ")}]`,
                  stepKind: "spawn_agent",
                },
              });
            }
            const claim = await context.executionLog.claim(stepIdempotencyKey);
            if (claim.kind === "complete") {
              stepResults.push({ step, status: "executed", output: claim.output });
              break;
            }
            if (claim.kind === "pending") {
              return failedResult(trigger.id, stepResults, {
                step,
                status: "failed",
                error: {
                  code: "STEP_FAILED",
                  message:
                    "Previous spawn_agent attempt is in indeterminate state " +
                    `(claimed but not finalized); manual reconciliation required for key ${stepIdempotencyKey}`,
                  stepKind: "spawn_agent",
                  idempotencyKey: stepIdempotencyKey,
                },
              });
            }
            claimedKey = stepIdempotencyKey;
            const output = await context.spawn({
              agentType: step.agentType,
              input: step.input,
              delivery: step.delivery,
              idempotencyKey: stepIdempotencyKey,
            });
            state.committedNewWork = true;

            await context.executionLog.record(stepIdempotencyKey, output);
            stepResults.push({ step, status: "executed", output });
            break;
          }

          case "forge_skill": {
            if (context.forge === undefined) {
              await emitGap(trigger, step);
              return unsupportedResult(trigger.id, stepResults, stepUnsupported(step));
            }
            if (
              context.allowedForgeBrickKinds !== undefined &&
              !context.allowedForgeBrickKinds.includes(step.demand.suggestedBrickKind)
            ) {
              return failedResult(trigger.id, stepResults, {
                step,
                status: "failed",
                error: {
                  code: "INVALID_PLAN",
                  message: `forge_skill suggestedBrickKind "${step.demand.suggestedBrickKind}" is not in the allowlist [${context.allowedForgeBrickKinds.join(", ")}]`,
                  stepKind: "forge_skill",
                },
              });
            }
            const claim = await context.executionLog.claim(stepIdempotencyKey);
            if (claim.kind === "complete") {
              stepResults.push({ step, status: "executed", output: claim.output });
              break;
            }
            if (claim.kind === "pending") {
              return failedResult(trigger.id, stepResults, {
                step,
                status: "failed",
                error: {
                  code: "STEP_FAILED",
                  message:
                    "Previous forge_skill attempt is in indeterminate state " +
                    `(claimed but not finalized); manual reconciliation required for key ${stepIdempotencyKey}`,
                  stepKind: "forge_skill",
                  idempotencyKey: stepIdempotencyKey,
                },
              });
            }
            claimedKey = stepIdempotencyKey;
            const output = await context.forge({
              demand: step.demand,
              idempotencyKey: stepIdempotencyKey,
            });
            state.committedNewWork = true;

            await context.executionLog.record(stepIdempotencyKey, output);
            stepResults.push({ step, status: "executed", output });
            break;
          }

          case "tool_call": {
            if (context.toolCall === undefined) {
              await emitGap(trigger, step);
              return unsupportedResult(trigger.id, stepResults, stepUnsupported(step));
            }
            if (
              context.allowedToolNames !== undefined &&
              !context.allowedToolNames.includes(step.toolName)
            ) {
              return failedResult(trigger.id, stepResults, {
                step,
                status: "failed",
                error: {
                  code: "INVALID_PLAN",
                  message: `tool_call toolName "${step.toolName}" is not in the allowlist [${context.allowedToolNames.join(", ")}]`,
                  stepKind: "tool_call",
                },
              });
            }
            const claim = await context.executionLog.claim(stepIdempotencyKey);
            if (claim.kind === "complete") {
              stepResults.push({ step, status: "executed", output: claim.output });
              break;
            }
            if (claim.kind === "pending") {
              return failedResult(trigger.id, stepResults, {
                step,
                status: "failed",
                error: {
                  code: "STEP_FAILED",
                  message:
                    "Previous tool_call attempt is in indeterminate state " +
                    `(claimed but not finalized); manual reconciliation required for key ${stepIdempotencyKey}`,
                  stepKind: "tool_call",
                  idempotencyKey: stepIdempotencyKey,
                },
              });
            }
            claimedKey = stepIdempotencyKey;
            const output = await context.toolCall({
              toolName: step.toolName,
              input: step.input,
              idempotencyKey: stepIdempotencyKey,
            });
            state.committedNewWork = true;

            await context.executionLog.record(stepIdempotencyKey, output);
            stepResults.push({ step, status: "executed", output });
            break;
          }
        }
      } catch (cause) {
        if (claimedKey !== undefined) {
          if (isPreCommitRejection(cause)) {
            // Caller proved no durable side effect committed; release the
            // claim so an ordinary retry with corrected input succeeds.
            // A release() failure must NOT abort execute() — the original
            // pre-commit error is still the actionable failure for the
            // caller, and a degraded log backend should not turn a
            // structured rejection into an uncaught throw. Compose the
            // release error into the message so operators see both.
            try {
              await context.executionLog.release(claimedKey);
            } catch (releaseCause) {
              const original = cause instanceof Error ? cause.message : String(cause);
              const releaseMsg =
                releaseCause instanceof Error ? releaseCause.message : String(releaseCause);
              return failedResult(
                trigger.id,
                stepResults,
                stepFailed(
                  step,
                  new Error(
                    `${original} (release() also failed for key ${claimedKey}: ${releaseMsg})`,
                  ),
                  claimedKey,
                ),
              );
            }
          }
          // For ambiguous throws, leave the claim pending and surface the
          // idempotency key so operators can reconcile from this failure.
          return failedResult(trigger.id, stepResults, stepFailed(step, cause, claimedKey));
        }
        return failedResult(trigger.id, stepResults, stepFailed(step, cause));
      }
      // Step pushed successfully (failures return early above) — snapshot
      // progress so a host watching the checkpoint store sees the plan
      // advancing step-by-step.
      await saveProgress(plan, stepResults, "in_progress");
    }

    return {
      triggerId: trigger.id,
      status: "executed",
      stepResults,
      executedCount: stepResults.length,
    };
  }

  return {
    async execute(
      trigger: CompositionTrigger,
      plan: CompositionPlan,
    ): Promise<CompositionExecutionResult> {
      // Fail fast on host-misconfigured snapshot wiring (store without id).
      // Surface as a structured INVALID_PLAN so the contract still holds.
      if (missingExecutionId) {
        return {
          triggerId: trigger.id,
          status: "failed",
          stepResults: [],
          executedCount: 0,
          error: {
            code: "INVALID_PLAN",
            message: "checkpointStore is configured but executionId is missing or empty",
          },
        };
      }
      const state = { committedNewWork: false, acquiredSessionSlot: false };
      const result = await runPlan(trigger, plan, state);
      // Terminal snapshot housekeeping. Pure success deletes the snapshot
      // (no in-flight execution to resume). Any non-terminal-success
      // outcome — failed / unsupported / requires_approval — leaves a
      // `phase: "failed"` snapshot so hosts can enumerate executions that
      // stopped short. (`requires_approval` runs zero steps; the snapshot
      // is still useful as a signal that the plan was attempted.)
      if (result.status === "executed") {
        await deleteProgress();
      } else {
        // Cast widening: result.stepResults narrows differently per status
        // (failed/unsupported include the final non-executed step). Snapshot
        // only the executed prefix to match `nextStepIndex` semantics.
        const executedPrefix: ExecutedStepResult[] = [];
        for (const r of result.stepResults) {
          if (r.status === "executed") executedPrefix.push(r);
          else break;
        }
        await saveProgress(plan, executedPrefix, "failed");
      }
      return finalize(trigger, plan, result, state.committedNewWork, state.acquiredSessionSlot);
    },
  };
}
