import type {
  AgentId,
  CompositionExecutionError,
  CompositionExecutionResult,
  CompositionExecutor,
  CompositionPlan,
  CompositionStep,
  CompositionStepResult,
  CompositionTrigger,
  DeliveryPolicy,
  EngineInput,
  ForgeDemandSignal,
  SchedulerComponent,
} from "@koi/core";

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
  readonly scheduler: SchedulerComponent;
  readonly notify: (notification: CompositionNotification) => Promise<unknown>;
  readonly spawn?: ((request: CompositionSpawnRequest) => Promise<unknown>) | undefined;
  readonly forge?: ((request: CompositionForgeRequest) => Promise<unknown>) | undefined;
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
}

const DEFAULT_ALLOWED_NOTIFY_CHANNELS: readonly string[] = ["inbox"];

type ExecutedStepResult = Extract<CompositionStepResult, { status: "executed" }>;

/**
 * Branded error indicating a pre-commit validation rejection — no durable
 * side effect was produced. Scheduler/notify implementations throw this
 * (via `preCommitRejection(...)`) to let the executor release the claimed
 * key, so ordinary callers can fix the input and retry without manual
 * reconciliation. Plain `Error` throws are treated as ambiguous and leave
 * the claim pending.
 */
// Cross-realm brand keyed by a well-known string. Symbol.for() returns the
// same symbol across module/bundle/version-skew copies, so a rejection
// thrown by another instance of @koi/proactive (or any package that
// imports preCommitRejection() from any copy of this module) is still
// recognized. Plain Error objects cannot accidentally carry this key —
// they would have to call Symbol.for("@koi/proactive/preCommitRejection")
// explicitly, which is treated as opt-in to the contract.
const PRE_COMMIT_BRAND_KEY = "@koi/proactive/preCommitRejection" as const;
const PRE_COMMIT_BRAND: unique symbol = Symbol.for(PRE_COMMIT_BRAND_KEY) as never;

// Opaque exported type — produced only by `preCommitRejection(...)` and
// recognized only by `isPreCommitRejection(...)`. Consumers cannot
// synthesize one from a plain Error.
export interface CompositionPreCommitRejection extends Error {
  readonly [PRE_COMMIT_BRAND]: true;
}

export function preCommitRejection(
  message: string,
  cause?: unknown,
): CompositionPreCommitRejection {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  Object.defineProperty(error, PRE_COMMIT_BRAND, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return error as CompositionPreCommitRejection;
}

export function isPreCommitRejection(value: unknown): value is CompositionPreCommitRejection {
  if (!(value instanceof Error)) return false;
  return (value as unknown as { [PRE_COMMIT_BRAND]?: unknown })[PRE_COMMIT_BRAND] === true;
}

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
  trigger: CompositionTrigger,
  occurrenceIndex: number,
  step: CompositionStep,
): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(
    JSON.stringify({
      triggerId: trigger.id,
      emittedAt: trigger.emittedAt,
      occurrenceIndex,
      step: canonicalize(stripIgnoredFields(step)),
    }),
  );
  return `cmp-${hasher.digest("hex").slice(0, 32)}`;
}

// Options that scheduler.schedule() backends (notably Temporal) reject as
// pre-commit validation errors. Validate in the executor before claiming the
// log key so a malformed plan surfaces as INVALID_PLAN (re-plannable) rather
// than wedging the log with a pending claim from a deterministic failure.
const UNSUPPORTED_SCHEDULE_OPTION_KEYS = [
  "timeoutMs",
  "maxRetries",
  "delayMs",
  "priority",
  "metadata",
  "idempotencyKey",
] as const;

function unsupportedScheduleOption(
  step: Extract<CompositionStep, { kind: "create_schedule" }>,
): string | undefined {
  if (step.taskOptions === undefined) return undefined;
  for (const key of UNSUPPORTED_SCHEDULE_OPTION_KEYS) {
    if (step.taskOptions[key] !== undefined) return key;
  }
  return undefined;
}

function approvalRequired(trigger: CompositionTrigger): CompositionExecutionResult {
  return {
    triggerId: trigger.id,
    status: "requires_approval",
    stepResults: [],
    executedCount: 0,
    error: {
      code: "APPROVAL_REQUIRED",
      message: "Composition plan requires approval before execution.",
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
  return {
    async execute(
      trigger: CompositionTrigger,
      plan: CompositionPlan,
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
      // Trigger ids are not guaranteed unique across emissions, so a stale
      // plan from emission A would otherwise execute against emission B.
      // Only enforced when the plan declares emittedAt — older planners
      // that pre-date this field still get triggerId-only validation.
      if (
        plan.triggerEmittedAt !== undefined &&
        plan.triggerEmittedAt !== trigger.emittedAt
      ) {
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

      if (plan.requiresApproval) return approvalRequired(trigger);

      const allowedChannels =
        context.allowedNotifyChannels ?? DEFAULT_ALLOWED_NOTIFY_CHANNELS;

      const stepResults: ExecutedStepResult[] = [];

      // Per-content occurrence counter — the Nth identical step in a plan
      // gets occurrenceIndex N. Stable across reorders of unrelated steps.
      const occurrenceCounts = new Map<string, number>();

      for (let index = 0; index < plan.steps.length; index += 1) {
        const step = plan.steps[index]!;
        const fingerprint = stepFingerprint(step);
        const occurrenceIndex = occurrenceCounts.get(fingerprint) ?? 0;
        occurrenceCounts.set(fingerprint, occurrenceIndex + 1);
        const stepIdempotencyKey = deriveStepIdempotencyKey(trigger, occurrenceIndex, step);
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
              const { idempotencyKey: _ignored, ...submitOptions } = step.taskOptions ?? {};
              const output = await context.scheduler.submit(step.input, step.mode, {
                ...submitOptions,
                idempotencyKey: stepIdempotencyKey,
              });
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

              // Reject options that scheduler.schedule() backends deterministically
              // throw on (e.g. Temporal rejects timeoutMs/maxRetries/delayMs/
              // priority/metadata/idempotencyKey). Surfacing this BEFORE the
              // execution-log claim keeps the log clean — otherwise the
              // deterministic throw would leave the claim pending and require
              // operator reconciliation.
              const unsupported = unsupportedScheduleOption(step);
              if (unsupported !== undefined) {
                return failedResult(trigger.id, stepResults, {
                  step,
                  status: "failed",
                  error: {
                    code: "INVALID_PLAN",
                    message: `create_schedule taskOptions.${unsupported} is not supported — scheduler backends cannot persist or enforce it on cron firings`,
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

              // Forward only `timezone` to schedule(). All other taskOptions
              // were either rejected upstream by `unsupportedScheduleOption`
              // or are not enforceable on scheduled firings.
              // Throw handling past this point: pre-commit rejections release
              // the claim (caller can fix and retry without operator
              // intervention); other throws leave the claim pending and
              // surface the key for operator reconciliation.
              const output = await context.scheduler.schedule(
                step.expression,
                step.input,
                step.mode,
                step.timezone === undefined ? undefined : { timezone: step.timezone },
              );
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
              await context.executionLog.record(stepIdempotencyKey, notifyOutput);
              stepResults.push({ step, status: "executed", output: notifyOutput });
              break;
            }

            case "spawn_agent":
            case "forge_skill":
            case "tool_call":
              return unsupportedResult(trigger.id, stepResults, stepUnsupported(step));
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
      }

      return {
        triggerId: trigger.id,
        status: "executed",
        stepResults,
        executedCount: stepResults.length,
      };
    },
  };
}
