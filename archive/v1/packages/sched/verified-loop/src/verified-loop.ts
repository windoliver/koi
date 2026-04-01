/**
 * Core VerifiedLoop orchestration.
 *
 * Iterates PRD items through external verification gates,
 * recording learnings and per-iteration metrics.
 */

import { dirname, join } from "node:path";
import { extractMessage } from "@koi/errors";
import { appendLearning, readLearnings } from "./learnings.js";
import { markDone, markSkipped, nextItem, readPRD } from "./prd-store.js";
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

  // Link external signal to our internal controller
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
      // Track consecutive failures per item for stuck-loop detection
      const consecutiveFailures = new Map<string, number>();

      // Read PRD — fail fast if missing
      const prdResult = await readPRD(config.prdPath);
      if (!prdResult.ok) {
        return {
          iterations: 0,
          completed: [],
          remaining: [],
          skipped: [],
          learnings: [],
          durationMs: performance.now() - startTime,
          iterationRecords: [],
        };
      }

      // Check if already done (all items done or skipped)
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
        // Use let — justified: loop counter
        let i = 1;
        i <= maxIterations && !abortController.signal.aborted;
        i++
      ) {
        const iterStart = performance.now();

        // Re-read PRD each iteration (filesystem is source of truth)
        const currentPrd = await readPRD(config.prdPath);
        if (!currentPrd.ok) {
          break;
        }

        const current = nextItem(currentPrd.value.items);
        if (!current) {
          break; // all done or skipped
        }

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

        // Run iteration — race against timeout + abort signal
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

        // Run verification gate — race against gate timeout + abort signal
        // Use let — justified: mutable gate result across try/catch
        let gateResult: VerificationResult;
        try {
          const gateSignal = AbortSignal.any([
            abortController.signal,
            AbortSignal.timeout(gateTimeoutMs),
          ]);
          const gatePromise = config.verify({
            iteration: i,
            currentItem: current,
            workingDir,
            iterationRecords: [...iterationRecords],
            learnings,
            remainingItems,
            completedItems,
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

        // Mark completed items — deduplicate to prevent inflated iterationCount
        if (gateResult.passed && gateResult.itemsCompleted) {
          const uniqueCompleted = [...new Set(gateResult.itemsCompleted)];
          for (const itemId of uniqueCompleted) {
            const doneResult = await markDone(config.prdPath, itemId);
            if (!doneResult.ok) {
              console.warn(
                `[verified-loop] Failed to mark item "${itemId}" as done: ${doneResult.error.message}`,
              );
            }
            consecutiveFailures.delete(itemId);
          }
        } else if (gateResult.passed) {
          const doneResult = await markDone(config.prdPath, current.id);
          if (!doneResult.ok) {
            console.warn(
              `[verified-loop] Failed to mark item "${current.id}" as done: ${doneResult.error.message}`,
            );
          }
          consecutiveFailures.delete(current.id);
        }

        // Track consecutive failures for stuck-loop detection
        if (!gateResult.passed) {
          const prevCount = consecutiveFailures.get(current.id) ?? 0;
          const newCount = prevCount + 1;
          consecutiveFailures.set(current.id, newCount);

          // Skip item if it hit the consecutive failure threshold
          if (newCount >= maxConsecutiveFailures) {
            const skipResult = await markSkipped(config.prdPath, current.id);
            if (!skipResult.ok) {
              console.warn(
                `[verified-loop] Failed to mark item "${current.id}" as skipped: ${skipResult.error.message}`,
              );
            }
          }
        }

        // Append learning
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
        await appendLearning(learningsPath, learningEntry, maxLearningEntries);

        const record: IterationRecord = {
          iteration: i,
          itemId: current.id,
          durationMs: performance.now() - iterStart,
          gateResult,
          error: iterError,
        };
        iterationRecords.push(record);
        config.onIteration?.(record);
      }

      // Build final result
      const finalPrd = await readPRD(config.prdPath);
      const finalItems = finalPrd.ok ? finalPrd.value.items : [];

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
