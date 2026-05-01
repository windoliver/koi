/**
 * Core VerifiedLoop orchestration.
 *
 * Iterates PRD items through external verification gates,
 * recording learnings and per-iteration metrics.
 */

import { readLearnings } from "./learnings.js";
import {
  acquirePRDLock,
  type PRDLock,
  readPRD,
  refreshPRDLock,
  releasePRDLock,
} from "./prd-store.js";
import type {
  IterationRecord,
  VerifiedLoop,
  VerifiedLoopConfig,
  VerifiedLoopResult,
} from "./types.js";
import { type ResolvedConfig, resolveConfig } from "./verified-loop-config.js";
import { runIteration } from "./verified-loop-iteration.js";

// Refresh the PRD lock heartbeat on a wall-clock timer so a single long
// iteration cannot exceed the staleness threshold and let a peer steal
// the lock. 60s is well under the 15-min stale window and adds one
// rename syscall per minute — negligible compared to iteration cost.
const HEARTBEAT_REFRESH_INTERVAL_MS = 60_000;

/** Create a VerifiedLoop orchestrator. */
export function createVerifiedLoop(config: VerifiedLoopConfig): VerifiedLoop {
  const resolved = resolveConfig(config);

  // Single-use enforcement. Sharing one AbortController across multiple
  // run() calls would mean: a stop() on call N silently disables call N+1
  // (the signal stays aborted forever). Concurrent run() calls would
  // race themselves on the same PRD with shared cancellation. Make the
  // contract explicit instead: each createVerifiedLoop() returns a
  // single-use, single-flight loop. Use a fresh factory call to start a
  // new run.
  // Use let — justified: lifecycle flag toggled by run().
  let runState: "pending" | "running" | "completed" = "pending";
  // Use let — justified: assigned on run() entry so stop() can target
  // the live invocation; null between runs.
  let abortController: AbortController | null = null;

  return {
    run: async (): Promise<VerifiedLoopResult> => {
      assertCanRun(runState);
      runState = "running";
      const lock = await acquireOrFail(resolved.prdPath, () => {
        runState = "completed";
      });
      const ac = new AbortController();
      abortController = ac;
      attachExternalSignal(ac, config.signal);
      const heartbeatTimer = startHeartbeat(ac, lock);
      try {
        return await runOnce(config, resolved, ac, lock);
      } finally {
        clearInterval(heartbeatTimer);
        runState = "completed";
        await releasePRDLock(lock);
      }
    },

    stop: (): void => {
      // Idempotent — stopping a non-running or already-completed loop is a
      // no-op. Targets only the in-flight run; a future invocation would
      // throw at the lifecycle guard above anyway.
      abortController?.abort("Verified loop stopped");
    },
  };
}

async function acquireOrFail(prdPath: string, onFail: () => void): Promise<PRDLock> {
  // Acquire the PRD lock BEFORE setting up the abort controller or
  // touching state. A dual-coordinator scenario (accidental restart,
  // duplicate scheduler fire, operator double-launch) would otherwise
  // race byte-for-byte CAS and silently lose updates. The lock is
  // released in the finally regardless of outcome.
  const lockResult = await acquirePRDLock(prdPath);
  if (!lockResult.ok) {
    onFail();
    throw new Error(
      `VerifiedLoop.run(): cannot acquire PRD lock (${lockResult.error.code}): ${lockResult.error.message}`,
    );
  }
  return lockResult.value;
}

function assertCanRun(runState: "pending" | "running" | "completed"): void {
  if (runState === "running") {
    throw new Error(
      "VerifiedLoop.run(): already running — this loop instance is single-flight; create a new instance for a parallel run",
    );
  }
  if (runState === "completed") {
    throw new Error(
      "VerifiedLoop.run(): this loop instance has already completed; create a new instance to run again",
    );
  }
}

function attachExternalSignal(ac: AbortController, signal: AbortSignal | undefined): void {
  if (!signal) return;
  if (signal.aborted) {
    ac.abort(signal.reason);
  } else {
    signal.addEventListener("abort", () => {
      ac.abort(signal.reason);
    });
  }
}

function startHeartbeat(ac: AbortController, lock: PRDLock): ReturnType<typeof setInterval> {
  // Independent wall-clock heartbeat refresh. The per-iteration
  // refresh inside runOnce is not enough on its own: a caller can
  // legally configure a single iteration to run longer than
  // HEARTBEAT_STALE_MS (no upper bound on iterationTimeoutMs +
  // gateTimeoutMs), after which a peer would classify this live
  // lock as stale and start a second coordinator. The interval
  // ensures heartbeat freshness regardless of iteration length.
  // unref() so a lingering interval cannot keep the event loop
  // alive past loop completion.
  //
  // Heartbeat failure is FATAL: abort the abortController so the
  // current iteration tears down ASAP, and pre-write ownership
  // checks in runOnce refuse to mutate the PRD without a held
  // lock. Without this, a stale-broken coordinator could keep
  // calling markDoneMany / bumpFailureCount for the rest of its
  // current iteration before noticing it lost the lock.
  const timer = setInterval(async () => {
    const refreshed = await refreshPRDLock(lock).catch(() => false);
    if (!refreshed) {
      ac.abort(
        new Error(
          `VerifiedLoop: lost PRD lock at ${lock.path} (heartbeat refresh failed; another coordinator may have stale-broken our lock)`,
        ),
      );
    }
  }, HEARTBEAT_REFRESH_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

// The actual run loop, factored out so the lifecycle guard above stays
// readable and the abort controller is scoped to each invocation.
async function runOnce(
  config: VerifiedLoopConfig,
  resolved: ResolvedConfig,
  abortController: AbortController,
  lock: PRDLock,
): Promise<VerifiedLoopResult> {
  const startTime = performance.now();
  const iterationRecords: IterationRecord[] = [];

  const prdResult = await readPRD(resolved.prdPath);
  if (!prdResult.ok) {
    // Cannot read or parse the PRD — refuse to silently succeed.
    // A scheduler that gets `iterations: 0` from a missing/corrupt PRD
    // would falsely mark the run as a clean no-op. Surface the error.
    throw new Error(
      `VerifiedLoop: cannot read PRD at ${resolved.prdPath} (${prdResult.error.code}): ${prdResult.error.message}`,
    );
  }

  if (prdResult.value.items.every((i) => i.done || i.skipped)) {
    return {
      iterations: 0,
      completed: prdResult.value.items.filter((i) => i.done).map((i) => i.id),
      remaining: [],
      skipped: prdResult.value.items.filter((i) => i.skipped).map((i) => i.id),
      learnings: await readLearnings(resolved.learningsPath),
      durationMs: performance.now() - startTime,
      iterationRecords: [],
    };
  }

  for (
    // Use let — justified: outer loop counter
    let i = 1;
    i <= resolved.maxIterations && !abortController.signal.aborted;
    i++
  ) {
    const reached = await runIteration({
      iteration: i,
      config,
      resolved,
      abortController,
      lock,
      iterationRecords,
    });
    if (reached === "no-more-items") break;
  }

  return await buildFinalResult(resolved, iterationRecords, startTime);
}

async function buildFinalResult(
  resolved: ResolvedConfig,
  iterationRecords: readonly IterationRecord[],
  startTime: number,
): Promise<VerifiedLoopResult> {
  const finalPrd = await readPRD(resolved.prdPath);
  if (!finalPrd.ok) {
    // Same contract as the initial and mid-loop reads — never collapse a
    // storage failure into "0 items, all done". Force the caller to handle.
    throw new Error(
      `VerifiedLoop: cannot read final PRD at ${resolved.prdPath} (${finalPrd.error.code}): ${finalPrd.error.message}`,
    );
  }
  const finalItems = finalPrd.value.items;

  return {
    iterations: iterationRecords.length,
    completed: finalItems.filter((i) => i.done).map((i) => i.id),
    remaining: finalItems.filter((i) => !i.done && !i.skipped).map((i) => i.id),
    skipped: finalItems.filter((i) => i.skipped === true).map((i) => i.id),
    learnings: await readLearnings(resolved.learningsPath),
    durationMs: performance.now() - startTime,
    iterationRecords,
  };
}
