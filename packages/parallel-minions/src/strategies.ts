/**
 * Execution strategies for parallel task batches.
 *
 * Each factory returns an ExecutionStrategy function that orchestrates
 * concurrent task execution with different failure semantics.
 */

import type {
  BatchResult,
  ExecutionContext,
  ExecutionStrategy,
  MinionOutcome,
  ResolvedTask,
} from "./types.js";

// ---------------------------------------------------------------------------
// Shared helper
// ---------------------------------------------------------------------------

const TRUNCATION_MARKER = "\n... [output truncated]";

/** Truncates output to maxLen characters, appending a marker if truncated. */
function truncateOutput(output: string, maxLen: number): string {
  if (output.length <= maxLen) return output;
  return output.slice(0, maxLen - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

/**
 * Runs a single task through the semaphore → spawn → truncate pipeline.
 *
 * Always releases the semaphore slot, even on throw.
 */
async function runOneTask(task: ResolvedTask, ctx: ExecutionContext): Promise<MinionOutcome> {
  await ctx.semaphore.acquire(task.agentType);
  try {
    if (ctx.batchSignal.aborted) {
      return { ok: false, taskIndex: task.index, error: "Batch aborted" };
    }
    const result = await ctx.spawn({
      description: task.description,
      agentName: task.agentName,
      manifest: task.manifest,
      signal: ctx.batchSignal,
      taskIndex: task.index,
    });

    if (result.ok) {
      return {
        ok: true,
        taskIndex: task.index,
        output: truncateOutput(result.output, ctx.maxOutputPerTask),
      };
    }
    return { ok: false, taskIndex: task.index, error: result.error };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, taskIndex: task.index, error: message };
  } finally {
    ctx.semaphore.release(task.agentType);
  }
}

// ---------------------------------------------------------------------------
// Strategy: best-effort
// ---------------------------------------------------------------------------

/**
 * Best-effort strategy: run all tasks, collect all outcomes regardless
 * of individual success or failure.
 */
export function createBestEffortStrategy(): ExecutionStrategy {
  return async (ctx: ExecutionContext): Promise<BatchResult> => {
    const promises = ctx.tasks.map((task) => runOneTask(task, ctx));
    const outcomes = await Promise.all(promises);
    const succeeded = outcomes.filter((o) => o.ok).length;

    return {
      outcomes,
      summary: {
        total: outcomes.length,
        succeeded,
        failed: outcomes.length - succeeded,
        strategy: "best-effort",
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Strategy: fail-fast
// ---------------------------------------------------------------------------

/**
 * Fail-fast strategy: abort the entire batch on the first failure.
 * In-flight tasks receive the abort signal. Queued tasks check the
 * signal before spawning and return "Batch aborted".
 */
export function createFailFastStrategy(): ExecutionStrategy {
  return async (ctx: ExecutionContext): Promise<BatchResult> => {
    const batchController = new AbortController();
    const combinedSignal = AbortSignal.any([ctx.batchSignal, batchController.signal]);

    const failFastCtx: ExecutionContext = {
      ...ctx,
      batchSignal: combinedSignal,
    };

    const promises = ctx.tasks.map(async (task): Promise<MinionOutcome> => {
      const outcome = await runOneTask(task, failFastCtx);
      if (!outcome.ok && !batchController.signal.aborted) {
        batchController.abort("fail-fast: task failed");
      }
      return outcome;
    });

    const outcomes = await Promise.all(promises);
    const succeeded = outcomes.filter((o) => o.ok).length;

    return {
      outcomes,
      summary: {
        total: outcomes.length,
        succeeded,
        failed: outcomes.length - succeeded,
        strategy: "fail-fast",
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Strategy: quorum
// ---------------------------------------------------------------------------

/**
 * Quorum strategy: once minSuccess tasks succeed, abort remaining tasks.
 * If all complete and successes < minSuccess, report quorum failure.
 */
export function createQuorumStrategy(minSuccess: number): ExecutionStrategy {
  return async (ctx: ExecutionContext): Promise<BatchResult> => {
    const quorumController = new AbortController();
    const combinedSignal = AbortSignal.any([ctx.batchSignal, quorumController.signal]);

    const quorumCtx: ExecutionContext = {
      ...ctx,
      batchSignal: combinedSignal,
    };

    // let justified: mutable counter tracking successes for quorum check
    let successCount = 0;

    const promises = ctx.tasks.map(async (task): Promise<MinionOutcome> => {
      const outcome = await runOneTask(task, quorumCtx);
      if (outcome.ok) {
        successCount += 1;
        if (successCount >= minSuccess && !quorumController.signal.aborted) {
          quorumController.abort("quorum reached");
        }
      }
      return outcome;
    });

    const outcomes = await Promise.all(promises);
    const succeeded = outcomes.filter((o) => o.ok).length;

    return {
      outcomes,
      summary: {
        total: outcomes.length,
        succeeded,
        failed: outcomes.length - succeeded,
        strategy: "quorum",
      },
    };
  };
}
