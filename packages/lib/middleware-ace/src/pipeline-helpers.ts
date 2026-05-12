/**
 * Pure helper functions split out of ace-middleware.ts to keep the main
 * file under the 800-line hard limit. No internal middleware state — all
 * helpers operate on parameters and pure values.
 */

import type { PlaybookProposal, TrajectoryEntry, TrajectoryRange } from "@koi/ace-types";
import type { AceStructuredPipelineConfig } from "./ace-middleware.js";
import { commitPromotion, rollbackPromotion } from "./promotion-gate.js";

const DEFAULT_STRUCTURED_TOKEN_BUDGET = 2000;

export function defaultIdGenerator(): string {
  return crypto.randomUUID();
}

/**
 * Coerce arbitrary thrown values to a string without invoking attacker code.
 * Never uses `instanceof` (proxy `getPrototypeOf` traps can throw) or property
 * access on objects (proxy `get` traps can throw); only inspects primitive
 * types and falls back to a constant marker for any object/function/symbol.
 */
export function safeString(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean" || t === "bigint") {
    return String(value);
  }
  return `[${t}]`;
}

/**
 * Log a structured-pipeline failure without ever rethrowing.
 * `pipelineErr` is the original failure; `handlerErr` is set when a wired
 * onError itself threw. All console.error invocations are wrapped because the
 * console implementation can throw (custom hooks, hostile arguments, etc.).
 */
/**
 * Extract ONLY the error class/typeof from a thrown value.
 *
 * Reflector/curator/evaluator/store errors commonly embed prompt fragments,
 * tool I/O, SQL text, or provider response bodies in `err.message`. The
 * default failure path therefore emits NO message content — only stable,
 * non-sensitive metadata. Callers who want rich error visibility must wire
 * `structuredPipeline.onError` explicitly (an opt-in trust-boundary cross).
 */
export function errorClassName(value: unknown): string {
  if (value === null || value === undefined) return safeString(value);
  const t = typeof value;
  if (t !== "object" && t !== "function") return `[${t}]`;

  try {
    const obj = value as { name?: unknown; constructor?: { name?: unknown } };
    const nameRaw = obj.name;
    if (typeof nameRaw === "string" && nameRaw.length > 0 && nameRaw.length <= 64) {
      return nameRaw;
    }
    const ctorNameRaw = obj.constructor?.name;
    if (typeof ctorNameRaw === "string" && ctorNameRaw.length > 0 && ctorNameRaw.length <= 64) {
      return ctorNameRaw;
    }
    return "Error";
  } catch {
    return "[error]";
  }
}

/**
 * Stable identifiers describing where in the pipeline a failure surfaced.
 * Logging the stage code (instead of a free-form message) keeps the default
 * log diagnosable without leaking per-session payloads.
 */
export type FailureContext = {
  readonly stage: string;
  readonly playbookId?: string;
  readonly sessionId?: string;
};

/**
 * Log a structured-pipeline failure as non-sensitive metadata only.
 * Emits stage + class + (optional) playbookId/sessionId, so operators can
 * locate and triage the failure without leaking per-session payloads.
 * Detailed diagnostics require an explicit `onError` handler.
 */
export function logFailureSafe(
  pipelineErr: unknown,
  handlerErr?: unknown,
  ctx?: FailureContext,
): void {
  try {
    const primary = errorClassName(pipelineErr);
    const tags: string[] = [`class=${primary}`];
    if (ctx?.stage !== undefined) tags.push(`stage=${ctx.stage}`);
    if (ctx?.playbookId !== undefined) tags.push(`playbookId=${ctx.playbookId}`);
    if (ctx?.sessionId !== undefined) tags.push(`sessionId=${ctx.sessionId}`);
    const tagStr = tags.join(" ");
    if (handlerErr !== undefined) {
      const secondary = errorClassName(handlerErr);
      console.error(
        `[ace] structured pipeline failure (${tagStr}); onError handler also failed (class=${secondary}); wire structuredPipeline.onError for details`,
      );
    } else {
      console.error(
        `[ace] structured pipeline failure (${tagStr}); wire structuredPipeline.onError for details`,
      );
    }
  } catch {
    // Last resort: swallow to honor the never-block-session-end contract.
  }
}

/**
 * Invoke `onError(err)` without blocking session teardown. Synchronous throws
 * AND promise rejections are caught and routed back through `logFailureSafe`.
 *
 * Hostile-handler safe: any failure while probing `result.then` (e.g. a
 * throwing getter on the return value) is also captured.
 */
export function invokeOnErrorDetached(
  onError: (err: unknown) => void | Promise<void>,
  err: unknown,
  ctx?: FailureContext,
): void {
  let result: void | Promise<void>;
  try {
    result = onError(err);
  } catch (handlerErr: unknown) {
    logFailureSafe(err, handlerErr, ctx);
    return;
  }
  // Promise.resolve coerces a thenable safely; if `then` access or invocation
  // throws synchronously, we wrap the whole probe in try/catch.
  let coerced: Promise<void>;
  try {
    coerced = Promise.resolve(result as void | Promise<void>);
  } catch (handlerErr: unknown) {
    logFailureSafe(err, handlerErr, ctx);
    return;
  }
  void coerced.catch((handlerErr: unknown) => {
    logFailureSafe(err, handlerErr, ctx);
  });
}

/** Determine an aggregate outcome label from compact trajectory entries. */
export function summarizeOutcome(
  entries: readonly TrajectoryEntry[],
): "success" | "failure" | "mixed" {
  let any = false;
  let allSuccess = true;
  let allFailure = true;
  for (const e of entries) {
    any = true;
    if (e.outcome === "success") allFailure = false;
    else if (e.outcome === "failure") allSuccess = false;
    else {
      allSuccess = false;
      allFailure = false;
    }
  }
  if (!any) return "mixed";
  if (allSuccess) return "success";
  if (allFailure) return "failure";
  return "mixed";
}

/**
 * Run the AGP propose -> evaluate -> commit pipeline for one session window.
 *
 * Failure modes are surfaced as thrown errors so the caller can route them to
 * `onError` without blocking session end. Successful execution returns void;
 * the promote/reject decision is encoded in the structured store + audit log.
 */
/** Identifies which pipeline stage produced a failure (for default logging). */
export type PipelineStage =
  | "load-playbook"
  | "reflect"
  | "curate"
  | "record-proposal"
  | "evaluate"
  | "resolve-rollback-target"
  | "rollback-decline"
  | "rollback-commit"
  | "commit";

/** Internal error wrapper carrying the pipeline stage for diagnostic logging. */
export class StagedPipelineError extends Error {
  readonly stage: PipelineStage;
  override readonly cause: unknown;
  constructor(stage: PipelineStage, cause: unknown) {
    // Embed the root-cause message so downstream handlers using `err.message`
    // or `String(err)` still see the actionable text (provider errors, SQL,
    // rollback misuse) instead of just the wrapper boilerplate.
    super(`ACE structured pipeline failed at stage=${stage}: ${causeMessage(cause)}`);
    this.name = "StagedPipelineError";
    this.stage = stage;
    this.cause = cause;
  }
}

/** Extract the cause's message safely (no instanceof, no proxy traps). */
function causeMessage(cause: unknown): string {
  if (cause === null || cause === undefined) return safeString(cause);
  const t = typeof cause;
  if (t !== "object" && t !== "function") return safeString(cause);
  try {
    const m = (cause as { message?: unknown }).message;
    if (typeof m === "string" && m.length > 0) return m;
    return errorClassName(cause);
  } catch {
    return "[error]";
  }
}

/** Known stage names; used to validate the `stage` field on a wrapped error. */
const KNOWN_STAGES: readonly PipelineStage[] = [
  "load-playbook",
  "reflect",
  "curate",
  "record-proposal",
  "evaluate",
  "resolve-rollback-target",
  "rollback-decline",
  "rollback-commit",
  "commit",
];

/**
 * Read the `stage` field from a thrown value WITHOUT using `instanceof`
 * (which would invoke `getPrototypeOf` on a proxy and could throw). Returns
 * "unknown" for any value that isn't a normal object exposing a known stage.
 */
export function extractStageSafe(value: unknown): string {
  if (value === null || value === undefined) return "unknown";
  const t = typeof value;
  if (t !== "object" && t !== "function") return "unknown";
  try {
    const stageRaw = (value as { stage?: unknown }).stage;
    if (typeof stageRaw === "string" && KNOWN_STAGES.includes(stageRaw as PipelineStage)) {
      return stageRaw;
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

async function runStage<T>(stage: PipelineStage, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (cause: unknown) {
    throw new StagedPipelineError(stage, cause);
  }
}

export async function runStructuredPipeline(
  sessionId: string,
  entries: readonly TrajectoryEntry[],
  pipe: AceStructuredPipelineConfig,
  clock: () => number,
): Promise<void> {
  // Defense-in-depth: never reflect/curate/commit on an empty trajectory.
  // The caller (onSessionEnd) already guards on entries.length === 0, but a
  // permissive reflector + curator could otherwise mutate a playbook from a
  // zero-evidence window if that guard ever moved.
  if (entries.length === 0) return;

  const playbook = await runStage("load-playbook", () => pipe.structuredStore.get(pipe.playbookId));
  if (playbook === undefined) {
    throw new StagedPipelineError(
      "load-playbook",
      new Error(`playbook ${pipe.playbookId} not found in structuredStore`),
    );
  }

  const outcome = summarizeOutcome(entries);
  const reflection = await runStage("reflect", () =>
    pipe.reflector({ trajectory: entries, outcome, playbook }),
  );

  const tokenBudget = pipe.tokenBudget ?? DEFAULT_STRUCTURED_TOKEN_BUDGET;
  const operations = await runStage("curate", () =>
    pipe.curator({ playbook, reflection, tokenBudget }),
  );

  // No-op curation: nothing to commit. Skip the gate entirely.
  if (operations.length === 0) return;

  const idGen = pipe.idGenerator ?? defaultIdGenerator;
  const now = clock();
  // Derive range from actual step coordinates (turnIndex), not array length.
  // entries.length conflates physical row count with logical step indexing,
  // which would let watermarks advance past real steps for sessions with
  // multiple entries per turn.
  let minTurn = Number.POSITIVE_INFINITY;
  let maxTurn = Number.NEGATIVE_INFINITY;
  for (const e of entries) {
    if (e.turnIndex < minTurn) minTurn = e.turnIndex;
    if (e.turnIndex > maxTurn) maxTurn = e.turnIndex;
  }
  const sourceTrajectoryRange: TrajectoryRange = {
    sessionId,
    fromStepIndex: minTurn,
    toStepIndex: maxTurn + 1,
  };

  const proposal: PlaybookProposal = {
    id: idGen(),
    playbookId: pipe.playbookId,
    baseVersion: playbook.version,
    operations,
    sourceTrajectoryRange,
    reflection,
    createdAt: now,
  };

  // Pre-record per the gate's contract: real proposal stores enforce a
  // baseVersion-FK on fresh inserts, so the proposal must be persisted while
  // baseVersion still equals the live head. Idempotent on retry.
  await runStage("record-proposal", () => pipe.proposalStore.recordProposal(proposal));

  const evaluation = await runStage("evaluate", () =>
    pipe.evaluator({
      trajectory: entries,
      proposal,
      playbookBefore: playbook,
    }),
  );

  // The gate handles promote / reject end-to-end (audit-first ordering, head
  // advance only on promote). Rollback verdicts are routed elsewhere — they
  // are not produced by the consolidation pipeline; an explicit rollback
  // operator drives those through rollbackPromotion() directly.
  if (evaluation.verdict === "rollback") {
    const resolveRollbackTarget = pipe.resolveRollbackTarget;
    if (resolveRollbackTarget === undefined) {
      // No handler wired: declined-by-config. Persist the evaluation BEFORE
      // surfacing the decline so the audit trail records what the evaluator
      // decided — losing this evidence on a rollback verdict (the most
      // safety-critical outcome) would let retries regenerate the same
      // proposal with no stored explanation of the prior decision.
      // Idempotent on byte-identical retry by the proposal-store contract.
      await runStage("rollback-decline", () => pipe.proposalStore.recordEvaluation(evaluation));
      throw new StagedPipelineError(
        "rollback-decline",
        new Error(
          "evaluator returned 'rollback' verdict but no resolveRollbackTarget handler is configured; head is unchanged.",
        ),
      );
    }
    const targetVersion = await runStage("resolve-rollback-target", () =>
      resolveRollbackTarget({ proposal, evaluation, playbookBefore: playbook }),
    );
    if (targetVersion === null) {
      // Handler ran and explicitly declined. Same audit-trail rationale —
      // record the evaluation before surfacing the decline.
      await runStage("rollback-decline", () => pipe.proposalStore.recordEvaluation(evaluation));
      throw new StagedPipelineError(
        "rollback-decline",
        new Error("resolveRollbackTarget returned null; head unchanged"),
      );
    }
    // Real rollback commit — failures here are operational outages
    // (missing lineage support, missing target version, save conflicts),
    // distinct from a benign decline.
    await runStage("rollback-commit", () =>
      rollbackPromotion(
        {
          structuredStore: pipe.structuredStore,
          proposalStore: pipe.proposalStore,
          clock,
        },
        proposal,
        targetVersion,
        evaluation,
      ),
    );
    return;
  }

  await runStage("commit", () =>
    commitPromotion(
      {
        structuredStore: pipe.structuredStore,
        proposalStore: pipe.proposalStore,
        clock,
      },
      proposal,
      evaluation,
      pipe.thresholds,
    ),
  );
}
