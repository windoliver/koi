/**
 * Core VerifiedLoop orchestration.
 *
 * Iterates PRD items through external verification gates,
 * recording learnings and per-iteration metrics.
 */

import { dirname, join } from "node:path";
import { extractMessage } from "@koi/errors";
import { appendLearning, readLearnings } from "./learnings.js";
import { bumpFailureCount, markDone, nextItem, readPRD } from "./prd-store.js";
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

  try {
    // Use let — justified: loop variable for iterator protocol
    let done = false;
    while (!done) {
      const result = await Promise.race([iterator.next(), abortPromise]);
      done = result.done === true;
    }
  } finally {
    await iterator.return?.();
  }
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
  const learningsPath = config.learningsPath ?? join(dirname(config.prdPath), "learnings.json");
  const iterationTimeoutMs = config.iterationTimeoutMs ?? DEFAULT_ITERATION_TIMEOUT_MS;
  const gateTimeoutMs = config.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
  const maxConsecutiveFailures = config.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;

  const abortController = new AbortController();

  if (config.signal) {
    if (config.signal.aborted) {
      abortController.abort(config.signal.reason);
    } else {
      config.signal.addEventListener("abort", () => {
        abortController.abort(config.signal?.reason);
      });
    }
  }

  return {
    run: async (): Promise<VerifiedLoopResult> => {
      const startTime = performance.now();
      const iterationRecords: IterationRecord[] = [];

      const prdResult = await readPRD(config.prdPath);
      if (!prdResult.ok) {
        // Cannot read or parse the PRD — refuse to silently succeed.
        // A scheduler that gets `iterations: 0` from a missing/corrupt PRD
        // would falsely mark the run as a clean no-op. Surface the error.
        throw new Error(
          `VerifiedLoop: cannot read PRD at ${config.prdPath} (${prdResult.error.code}): ${prdResult.error.message}`,
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

        const currentPrd = await readPRD(config.prdPath);
        if (!currentPrd.ok) {
          // PRD became unreadable mid-loop (concurrent overwrite, disk error,
          // or someone deleted it). Same as initial-read failure — surface it.
          throw new Error(
            `VerifiedLoop: PRD became unreadable mid-loop at ${config.prdPath} (${currentPrd.error.code}): ${currentPrd.error.message}`,
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
        try {
          const iterSignal = AbortSignal.any([
            abortController.signal,
            AbortSignal.timeout(iterationTimeoutMs),
          ]);
          const input: EngineInput = { kind: "text", text: promptText, signal: iterSignal };
          await drainWithAbort(config.runIteration(input), iterSignal);
        } catch (e: unknown) {
          iterError = extractMessage(e);
        }

        // Use let — justified: mutable gate result across try/catch
        let gateResult: VerificationResult;
        const gateSignal = AbortSignal.any([
          abortController.signal,
          AbortSignal.timeout(gateTimeoutMs),
        ]);
        try {
          const gatePromise = config.verify({
            iteration: i,
            currentItem: current,
            workingDir,
            iterationRecords: [...iterationRecords],
            learnings,
            remainingItems,
            completedItems,
            signal: gateSignal,
          });
          const timeoutPromise = new Promise<never>((_, reject) => {
            gateSignal.addEventListener("abort", () => reject(new Error("Gate timed out")), {
              once: true,
            });
          });
          gateResult = await Promise.race([gatePromise, timeoutPromise]);
        } catch (e: unknown) {
          gateResult = { passed: false, details: `Gate error: ${extractMessage(e)}` };
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
          // multiple work items). Prevents a typo or empty itemsCompleted
          // from silently stalling progress on the selected item.
          const toComplete = new Set<string>([current.id, ...(gateResult.itemsCompleted ?? [])]);
          for (const itemId of toComplete) {
            const doneResult = await markDone(config.prdPath, itemId);
            if (!doneResult.ok) {
              console.warn(
                `[verified-loop] Failed to mark item "${itemId}" as done: ${doneResult.error.message}`,
              );
            }
          }
        } else if (!cancelled) {
          // Persist the consecutive-failure count to disk in the same atomic
          // write that may also flip skipped:true. Survives crash/restart.
          const bumpResult = await bumpFailureCount(
            config.prdPath,
            current.id,
            maxConsecutiveFailures,
          );
          if (!bumpResult.ok) {
            console.warn(
              `[verified-loop] Failed to bump failure count for "${current.id}": ${bumpResult.error.message}`,
            );
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

      const finalPrd = await readPRD(config.prdPath);
      if (!finalPrd.ok) {
        // Same contract as the initial and mid-loop reads — never collapse a
        // storage failure into "0 items, all done". Force the caller to handle.
        throw new Error(
          `VerifiedLoop: cannot read final PRD at ${config.prdPath} (${finalPrd.error.code}): ${finalPrd.error.message}`,
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
    },

    stop: (): void => {
      abortController.abort("Verified loop stopped");
    },
  };
}
