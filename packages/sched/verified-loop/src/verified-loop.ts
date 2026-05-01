/**
 * Core VerifiedLoop orchestration.
 *
 * Iterates PRD items through external verification gates,
 * recording learnings and per-iteration metrics.
 */

import { dirname, isAbsolute, join, resolve } from "node:path";
import { extractMessage } from "@koi/errors";
import { appendLearning, readLearnings } from "./learnings.js";
import { bumpFailureCount, markDoneMany, nextItem, readPRD } from "./prd-store.js";
import type {
  EngineInput,
  IterationRecord,
  LearningsEntry,
  VerificationResult,
  VerifiedLoop,
  VerifiedLoopConfig,
  VerifiedLoopResult,
} from "./types.js";

const DEFAULT_MAX_ITERATIONS = 100;
const DEFAULT_MAX_LEARNING_ENTRIES = 50;
const DEFAULT_ITERATION_TIMEOUT_MS = 600_000;
const DEFAULT_GATE_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

const ITERATOR_RETURN_TIMEOUT_MS = 5_000;
const GATE_QUIESCE_TIMEOUT_MS = 5_000;

/**
 * Thrown when the runner's iterator.return() does not settle within the
 * grace window after abort/timeout. The runner is uncooperative — we must
 * fail the whole run rather than risk overlapping iterations.
 */
class RunnerStuckError extends Error {
  override readonly name = "RunnerStuckError";
}

/** Drain an async iterable, racing each next() against an AbortSignal. */
async function drainWithAbort(
  iterable: AsyncIterable<unknown>,
  signal: AbortSignal,
): Promise<void> {
  const iterator = iterable[Symbol.asyncIterator]();
  const abortPromise = new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(new Error("Iteration aborted"));
      return;
    }
    signal.addEventListener("abort", () => reject(new Error("Iteration aborted")), { once: true });
  });

  // Use let — justified: capture the drain-loop error (if any) so the
  // post-cleanup logic can decide whether to re-throw it or replace it
  // with a RunnerStuckError. We don't use try/finally with `throw` inside
  // finally (lint forbids; behavior also can't override an in-flight
  // throw from the try block — finally returns to unwinding).
  let drainError: unknown;
  // Use let — justified: track whether the drain ended naturally
  // (done:true) vs. via abort/exception. Cleanup is only enforced on
  // early exit; a post-EOF return() can be a no-op or destructive cleanup
  // for some adapters, and turning that into a fatal run-level error
  // would break compatible runners on the happy path.
  let exitedEarly = false;
  try {
    // Use let — justified: loop variable for iterator protocol
    let done = false;
    while (!done) {
      const result = await Promise.race([iterator.next(), abortPromise]);
      done = result.done === true;
    }
  } catch (e: unknown) {
    drainError = e;
    exitedEarly = true;
  }

  // Cleanup semantics only apply on early exit (abort/exception). Stuck or
  // rejected return() is dangerous only when the runner may still be doing
  // work — on natural EOF, it isn't.
  // Use let — justified: track race outcome and capture cleanup rejection.
  let stuckCleanup = false;
  let cleanupError: unknown;
  const returnFn = iterator.return;
  if (exitedEarly && returnFn === undefined) {
    // No return() implementation — we have no way to signal the runner to
    // stop, and we cannot prove its work has finished. Continuing the
    // loop while a non-cooperative runner may still be mutating the
    // workspace produces overlapping iterations and side effects.
    // Require runners to implement return() for cancellable iteration.
    throw new RunnerStuckError(
      "VerifiedLoop: runner async iterator has no return() method — cannot confirm cancellation; aborting run to avoid overlapping iterations",
    );
  }
  if (exitedEarly && returnFn !== undefined) {
    // Use let — justified: race outcome flag.
    let timedOut = false;
    // Capture rejections separately from successes — a runner that signals
    // cleanup failure (return() rejects) is just as dangerous as one that
    // hangs: we cannot assume side effects have stopped. Both must be fatal.
    const cleanup = returnFn.call(iterator).then(
      () => undefined,
      (e: unknown) => {
        cleanupError = e;
      },
    );
    const timeout = new Promise<void>((resolve) => {
      setTimeout(() => {
        timedOut = true;
        resolve();
      }, ITERATOR_RETURN_TIMEOUT_MS).unref?.();
    });
    await Promise.race([cleanup, timeout]);
    if (timedOut) stuckCleanup = true;
  }

  if (stuckCleanup) {
    // Stuck-runner condition deliberately replaces any in-flight abort
    // rejection: the exact cause matters less than the fact the runner
    // is uncancellable and the loop must not advance.
    throw new RunnerStuckError(
      `VerifiedLoop: runner iterator.return() did not settle within ${ITERATOR_RETURN_TIMEOUT_MS}ms; aborting run to avoid overlapping iterations`,
    );
  }
  if (cleanupError !== undefined) {
    // return() rejected — adapter explicitly reported cleanup failure. We
    // cannot guarantee the runner stopped, so refuse to advance.
    throw new RunnerStuckError(
      `VerifiedLoop: runner iterator.return() rejected during cleanup: ${extractMessage(cleanupError)}`,
    );
  }
  if (drainError !== undefined) throw drainError;
}

/** Create a VerifiedLoop orchestrator. */
export function createVerifiedLoop(config: VerifiedLoopConfig): VerifiedLoop {
  if (!config.prdPath) {
    throw new Error("VerifiedLoopConfig.prdPath is required");
  }
  if (!config.runIteration) {
    throw new Error("VerifiedLoopConfig.runIteration is required");
  }
  if (!config.verify) {
    throw new Error("VerifiedLoopConfig.verify is required");
  }
  if (!config.iterationPrompt) {
    throw new Error("VerifiedLoopConfig.iterationPrompt is required");
  }

  const maxIterations = config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const maxLearningEntries = config.maxLearningEntries ?? DEFAULT_MAX_LEARNING_ENTRIES;
  const workingDir = config.workingDir ?? process.cwd();
  // Resolve PRD and learnings paths against workingDir at construction so
  // every store call is process-cwd-independent. A loop launched from a
  // different cwd than its workspace must not silently read or overwrite
  // an unrelated PRD file. Absolute paths pass through unchanged.
  const prdPath = isAbsolute(config.prdPath) ? config.prdPath : resolve(workingDir, config.prdPath);
  const learningsPath =
    config.learningsPath !== undefined
      ? isAbsolute(config.learningsPath)
        ? config.learningsPath
        : resolve(workingDir, config.learningsPath)
      : join(dirname(prdPath), "learnings.json");
  const iterationTimeoutMs = config.iterationTimeoutMs ?? DEFAULT_ITERATION_TIMEOUT_MS;
  const gateTimeoutMs = config.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
  const maxConsecutiveFailures = config.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
  // Validate destructive numeric config upfront. A non-integer, NaN, or
  // < 1 value would let the FIRST failed verification flip skipped:true
  // into the PRD source of truth — silently dropping work that an
  // operator may not notice for a long time. Reject at construction.
  if (!Number.isInteger(maxConsecutiveFailures) || maxConsecutiveFailures < 1) {
    throw new Error(
      `VerifiedLoopConfig.maxConsecutiveFailures must be a positive integer (got ${String(maxConsecutiveFailures)})`,
    );
  }
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new Error(
      `VerifiedLoopConfig.maxIterations must be a positive integer (got ${String(maxIterations)})`,
    );
  }
  // Both timeouts feed AbortSignal.timeout(); negative or NaN values throw
  // TypeError at run time mid-loop, which corrupts the iteration record
  // mid-flight. Reject upfront with a structured error so the operator
  // sees a deterministic config failure instead of a stack trace from a
  // half-complete iteration.
  if (!Number.isInteger(iterationTimeoutMs) || iterationTimeoutMs < 1) {
    throw new Error(
      `VerifiedLoopConfig.iterationTimeoutMs must be a positive integer (got ${String(iterationTimeoutMs)})`,
    );
  }
  if (!Number.isInteger(gateTimeoutMs) || gateTimeoutMs < 1) {
    throw new Error(
      `VerifiedLoopConfig.gateTimeoutMs must be a positive integer (got ${String(gateTimeoutMs)})`,
    );
  }

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
      runState = "running";
      const ac = new AbortController();
      abortController = ac;
      if (config.signal) {
        if (config.signal.aborted) {
          ac.abort(config.signal.reason);
        } else {
          config.signal.addEventListener("abort", () => {
            ac.abort(config.signal?.reason);
          });
        }
      }
      try {
        return await runOnce(ac);
      } finally {
        runState = "completed";
      }
    },

    stop: (): void => {
      // Idempotent — stopping a non-running or already-completed loop is a
      // no-op. Targets only the in-flight run; a future invocation would
      // throw at the lifecycle guard above anyway.
      abortController?.abort("Verified loop stopped");
    },
  };

  // The actual run loop, factored out so the lifecycle guard above stays
  // readable and the abort controller is scoped to each invocation.
  async function runOnce(abortController: AbortController): Promise<VerifiedLoopResult> {
    const startTime = performance.now();
    const iterationRecords: IterationRecord[] = [];

    const prdResult = await readPRD(prdPath);
    if (!prdResult.ok) {
      // Cannot read or parse the PRD — refuse to silently succeed.
      // A scheduler that gets `iterations: 0` from a missing/corrupt PRD
      // would falsely mark the run as a clean no-op. Surface the error.
      throw new Error(
        `VerifiedLoop: cannot read PRD at ${prdPath} (${prdResult.error.code}): ${prdResult.error.message}`,
      );
    }

    if (prdResult.value.items.every((i) => i.done || i.skipped)) {
      return {
        iterations: 0,
        completed: prdResult.value.items.filter((i) => i.done).map((i) => i.id),
        remaining: [],
        skipped: prdResult.value.items.filter((i) => i.skipped).map((i) => i.id),
        learnings: await readLearnings(learningsPath),
        durationMs: performance.now() - startTime,
        iterationRecords: [],
      };
    }

    for (
      // Use let — justified: outer loop counter
      let i = 1;
      i <= maxIterations && !abortController.signal.aborted;
      i++
    ) {
      const iterStart = performance.now();

      const currentPrd = await readPRD(prdPath);
      if (!currentPrd.ok) {
        // PRD became unreadable mid-loop (concurrent overwrite, disk error,
        // or someone deleted it). Same as initial-read failure — surface it.
        throw new Error(
          `VerifiedLoop: PRD became unreadable mid-loop at ${prdPath} (${currentPrd.error.code}): ${currentPrd.error.message}`,
        );
      }

      const current = nextItem(currentPrd.value.items);
      if (!current) break;

      const learnings = await readLearnings(learningsPath);
      const remainingItems = currentPrd.value.items.filter((x) => !x.done && !x.skipped);
      const completedItems = currentPrd.value.items.filter((x) => x.done);

      const promptText = config.iterationPrompt({
        iteration: i,
        currentItem: current,
        remainingItems,
        completedItems,
        learnings,
        totalIterations: maxIterations,
      });

      // Use let — justified: mutable error tracking across try/catch
      let iterError: string | undefined;
      // Construct iterSignal in outer scope so we can check `.aborted`
      // after the drain to decide whether the iteration's work is trusted.
      const iterSignal = AbortSignal.any([
        abortController.signal,
        AbortSignal.timeout(iterationTimeoutMs),
      ]);
      try {
        const input: EngineInput = { kind: "text", text: promptText, signal: iterSignal };
        await drainWithAbort(config.runIteration(input), iterSignal);
      } catch (e: unknown) {
        // RunnerStuckError = uncancellable runner; we cannot proceed to
        // verification or the next iteration without risking overlapping
        // work. Surface it as a fatal run-level error.
        if (e instanceof RunnerStuckError) throw e;
        iterError = extractMessage(e);
      }

      // Use let — justified: mutable gate result.
      let gateResult: VerificationResult;
      if (iterSignal.aborted || iterError !== undefined) {
        // The iteration was aborted, timed out, or the runner threw.
        // Skip verify entirely: a stale workspace can satisfy a file gate
        // (passed:true) and falsely mark the item done despite the runner
        // never completing successfully. Runner crashes/exceptions are
        // just as untrusted as cancellation. Whether this counts against
        // the per-item failure budget is decided below by `cancelled`
        // (loop-level abort = no, runner crash = yes).
        const reason = iterSignal.aborted
          ? "Iteration aborted/timed out"
          : "Iteration runner threw";
        gateResult = {
          passed: false,
          details: iterError
            ? `${reason} before verification could run: ${iterError}`
            : `${reason} before verification could run`,
        };
      } else {
        const gateSignal = AbortSignal.any([
          abortController.signal,
          AbortSignal.timeout(gateTimeoutMs),
        ]);
        // Fail-fast if the loop has already been aborted before we
        // even invoke the gate. Otherwise verify() may run, resolve
        // {passed:true}, and slip past the abort race below (the
        // timeoutPromise listener is attached AFTER verify is called
        // — a synchronously-resolving gate would never observe it).
        if (gateSignal.aborted) {
          gateResult = { passed: false, details: "Gate aborted before start" };
        } else {
          // Catch synchronous throws while building the verifier promise
          // (missing dep, bad context, local validation) so they degrade
          // to a failed gate result instead of crashing the run. Don't
          // use Promise.resolve().then(...) here — that adds a microtask
          // delay that breaks the immediate-abort path in verify().
          // Use let — justified: try/catch must reassign across boundaries.
          let gatePromise: Promise<VerificationResult>;
          try {
            gatePromise = Promise.resolve(
              config.verify({
                iteration: i,
                currentItem: current,
                workingDir,
                iterationRecords: [...iterationRecords],
                learnings,
                remainingItems,
                completedItems,
                signal: gateSignal,
              }),
            );
          } catch (e: unknown) {
            gatePromise = Promise.reject(e);
          }
          try {
            const timeoutPromise = new Promise<never>((_, reject) => {
              gateSignal.addEventListener("abort", () => reject(new Error("Gate timed out")), {
                once: true,
              });
            });
            gateResult = await Promise.race([gatePromise, timeoutPromise]);
          } catch (e: unknown) {
            // Gate timed out or aborted. The gate's promise is still in
            // flight unless it cooperatively settles after seeing
            // gateSignal abort. Wait for quiescence with a bounded grace
            // budget; if the gate refuses to settle, fail the run fatally
            // — continuing while a verification call is still mutating
            // external systems would produce overlapping work.
            gateResult = { passed: false, details: `Gate error: ${extractMessage(e)}` };
            // Use let — justified: race outcome flag.
            let gateStuck = false;
            const settled = gatePromise.then(
              () => undefined,
              () => undefined,
            );
            const grace = new Promise<void>((resolve) => {
              setTimeout(() => {
                gateStuck = true;
                resolve();
              }, GATE_QUIESCE_TIMEOUT_MS).unref?.();
            });
            await Promise.race([settled, grace]);
            if (gateStuck) {
              throw new RunnerStuckError(
                `VerifiedLoop: gate did not quiesce within ${GATE_QUIESCE_TIMEOUT_MS}ms after timeout/abort; aborting run to avoid overlapping verification work`,
              );
            }
          }
        }
      }

      // Operator-stop / external-abort is NOT a verification failure. Do not
      // consume the per-item skip budget when the loop is being torn down —
      // a noisy operator who restarts often would otherwise mark unrelated
      // items as skipped. The abortController.signal is the loop-level signal
      // (loop.stop() or external config.signal); a per-call gate timeout
      // fires the local gateSignal but leaves abortController.signal clear.
      const cancelled = abortController.signal.aborted;

      if (gateResult.passed) {
        // A passing gate always marks the current item done. itemsCompleted
        // adds *additional* ids (e.g., a single iteration that completes
        // multiple work items). Persisted as ONE atomic write so a crash
        // cannot commit only a prefix of the verified set.
        const requested = [...new Set<string>([current.id, ...(gateResult.itemsCompleted ?? [])])];
        // Filter out ghost ids (gate-API misuse, not a storage error). The
        // current PRD snapshot is currentPrd.value — anything not present
        // there is logged and dropped before the atomic write.
        const validIds = new Set(currentPrd.value.items.map((it) => it.id));
        const toComplete = requested.filter((id) => {
          if (validIds.has(id)) return true;
          console.warn(
            `[verified-loop] Failed to mark item "${id}" as done: PRD item not found: ${id}`,
          );
          return false;
        });
        if (toComplete.length > 0) {
          // Retry CONFLICT (stale-snapshot from concurrent edit) once with
          // fresh state. A genuinely successful iteration must not be
          // replayed just because another writer touched an unrelated row;
          // that would re-execute non-idempotent side effects. NOT_FOUND /
          // VALIDATION / IO errors remain fatal.
          // Use let — justified: retry counter for stale-snapshot CAS races.
          let doneAttempts = 0;
          while (true) {
            doneAttempts++;
            const doneResult = await markDoneMany(prdPath, toComplete);
            if (doneResult.ok) break;
            if (doneResult.error.code !== "CONFLICT") {
              throw new Error(
                `VerifiedLoop: failed to persist completion for [${toComplete.join(", ")}] (${doneResult.error.code}): ${doneResult.error.message}`,
              );
            }
            // CONFLICT — re-read and check whether all the items are now
            // already done (work was committed by another path). If so,
            // success. If still pending, retry once with fresh snapshot.
            const recheck = await readPRD(prdPath);
            if (!recheck.ok) {
              throw new Error(
                `VerifiedLoop: PRD became unreadable after CONFLICT for [${toComplete.join(", ")}] (${recheck.error.code}): ${recheck.error.message}`,
              );
            }
            const allAlreadyDone = toComplete.every(
              (id) => recheck.value.items.find((it) => it.id === id)?.done === true,
            );
            if (allAlreadyDone) {
              console.warn(
                `[verified-loop] Skipping completion persistence for [${toComplete.join(", ")}] (already done)`,
              );
              break;
            }
            if (doneAttempts >= 2) {
              throw new Error(
                `VerifiedLoop: failed to persist completion for [${toComplete.join(", ")}] after retry (concurrent writers contending on PRD): ${doneResult.error.message}`,
              );
            }
          }
        }
      } else if (!cancelled && iterError === undefined && !iterSignal.aborted) {
        // Only count a bump when verification actually ran and returned
        // passed:false. Runner aborts/timeouts/throws never reached the
        // gate — treating those as per-item verification failures would
        // let transient infrastructure outages (engine crash, adapter
        // bug, auth hiccup, iteration timeout) accumulate against
        // maxConsecutiveFailures and durably mark untouched work as
        // skipped:true. The iterError/iterSignal-aborted branch above
        // already records gateResult.passed:false in iterationRecords
        // so the run still observes the failure; it just doesn't
        // consume the per-item skip budget.
        // Persist the consecutive-failure count to disk. May be retried
        // once on a stale-snapshot CONFLICT (concurrent unrelated edit);
        // a CONFLICT that resolves to "item is now done" is treated as
        // out-of-band completion and the bump is skipped. Other errors
        // remain fatal — without a working skip budget on disk, a
        // permanently failing item could be retried indefinitely.
        // Use let — justified: retry counter for stale-snapshot CAS races.
        let bumpAttempts = 0;
        while (true) {
          bumpAttempts++;
          const bumpResult = await bumpFailureCount(prdPath, current.id, maxConsecutiveFailures);
          if (bumpResult.ok) break;
          if (bumpResult.error.code !== "CONFLICT") {
            throw new Error(
              `VerifiedLoop: failed to persist failure count for "${current.id}" (${bumpResult.error.code}): ${bumpResult.error.message}`,
            );
          }
          // CONFLICT — distinguish "item became done out-of-band" from
          // "generic stale snapshot due to concurrent edit". Re-read.
          const recheck = await readPRD(prdPath);
          if (!recheck.ok) {
            throw new Error(
              `VerifiedLoop: PRD became unreadable after CONFLICT for "${current.id}" (${recheck.error.code}): ${recheck.error.message}`,
            );
          }
          const item = recheck.value.items.find((it) => it.id === current.id);
          if (item?.done === true) {
            console.warn(
              `[verified-loop] Skipping failure-count bump for "${current.id}" (already completed): ${bumpResult.error.message}`,
            );
            break;
          }
          // Generic stale-snapshot conflict (another writer touched
          // unrelated rows). Retry once with fresh state.
          if (bumpAttempts >= 2) {
            throw new Error(
              `VerifiedLoop: failed to persist failure count for "${current.id}" after retry (concurrent writers contending on PRD): ${bumpResult.error.message}`,
            );
          }
        }
      }

      const learningEntry: LearningsEntry = {
        iteration: i,
        timestamp: new Date().toISOString(),
        itemId: current.id,
        discovered: gateResult.passed ? [`Item ${current.id} completed`] : [],
        failed: iterError
          ? [iterError]
          : !gateResult.passed
            ? [gateResult.details ?? "Gate failed"]
            : [],
        context: `Working on: ${current.description}`,
      };
      // Learnings are advisory — never fail the run after PRD state has
      // already been mutated. A learnings disk error here would leave the
      // caller with a thrown run() but the authoritative item state already
      // committed, which is exactly the retry/rollback ambiguity we avoid.
      try {
        await appendLearning(learningsPath, learningEntry, maxLearningEntries);
      } catch (e: unknown) {
        console.warn(
          `[verified-loop] Failed to append learning entry (non-fatal): ${extractMessage(e)}`,
        );
      }

      const record: IterationRecord = {
        iteration: i,
        itemId: current.id,
        durationMs: performance.now() - iterStart,
        gateResult,
        error: iterError,
      };
      iterationRecords.push(record);
      if (config.onIteration) {
        try {
          config.onIteration(record);
        } catch (e: unknown) {
          console.warn(`[verified-loop] onIteration callback threw: ${extractMessage(e)}`);
        }
      }
    }

    const finalPrd = await readPRD(prdPath);
    if (!finalPrd.ok) {
      // Same contract as the initial and mid-loop reads — never collapse a
      // storage failure into "0 items, all done". Force the caller to handle.
      throw new Error(
        `VerifiedLoop: cannot read final PRD at ${prdPath} (${finalPrd.error.code}): ${finalPrd.error.message}`,
      );
    }
    const finalItems = finalPrd.value.items;

    return {
      iterations: iterationRecords.length,
      completed: finalItems.filter((i) => i.done).map((i) => i.id),
      remaining: finalItems.filter((i) => !i.done && !i.skipped).map((i) => i.id),
      skipped: finalItems.filter((i) => i.skipped === true).map((i) => i.id),
      learnings: await readLearnings(learningsPath),
      durationMs: performance.now() - startTime,
      iterationRecords,
    };
  }
}
