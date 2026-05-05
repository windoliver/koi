/**
 * Single-stage execution with cancellation + timeout race. Extracted
 * from pipeline.ts in R37 to keep pipeline.ts under the 800-line hard
 * limit; semantics unchanged.
 */

import type { StageContext, StageOutcome, VerifierStage } from "./types.js";

/**
 * Sentinel raised when the caller signal aborts mid-stage OR a per-stage
 * watchdog elapses. Distinguished from real stage throws so the caller
 * gets a TIMEOUT outcome rather than INTERNAL.
 */
const ABORT_BY_PIPELINE = Symbol("forge-verifier:abort");
class PipelineAbort extends Error {
  readonly [ABORT_BY_PIPELINE] = true;
}
function isPipelineAbort(e: unknown): e is PipelineAbort {
  return (
    e instanceof Error && (e as Error & { [ABORT_BY_PIPELINE]?: true })[ABORT_BY_PIPELINE] === true
  );
}

export function describeThrown(thrown: unknown): string {
  if (thrown instanceof Error) return thrown.message;
  if (typeof thrown === "string") return thrown;
  return "non-Error throw";
}

interface RunStageResult {
  readonly outcome: StageOutcome;
  readonly durationMs: number;
  readonly thrown?: unknown;
  readonly aborted?: true;
  readonly underlying: Promise<unknown>;
}

export async function runStage<I>(
  stage: VerifierStage<I>,
  artifact: I,
  ctx: StageContext,
  signal: AbortSignal | undefined,
  stageTimeoutMs: number | undefined,
): Promise<RunStageResult> {
  const started = performance.now();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  // Defer the `stage.run` invocation through a microtask so a SYNC
  // throw from a buggy plugin is normalized into a rejected promise
  // rather than escaping. Re-check the signal inside the microtask
  // too — a caller can abort in the gap between the outer loop's
  // pre-stage gate and this microtask firing.
  const underlying = Promise.resolve().then(() => {
    if (signal?.aborted === true) {
      throw new PipelineAbort("aborted before stage start (microtask race)");
    }
    return stage.run(artifact, ctx);
  });
  try {
    const racers: Promise<StageOutcome>[] = [underlying];
    if (signal !== undefined) {
      racers.push(
        new Promise<StageOutcome>((_, reject) => {
          if (signal.aborted) {
            reject(new PipelineAbort("aborted via signal"));
            return;
          }
          abortListener = (): void => reject(new PipelineAbort("aborted via signal"));
          signal.addEventListener("abort", abortListener, { once: true });
        }),
      );
    }
    if (stageTimeoutMs !== undefined && Number.isFinite(stageTimeoutMs) && stageTimeoutMs > 0) {
      racers.push(
        new Promise<StageOutcome>((_, reject) => {
          timeoutHandle = setTimeout(
            () =>
              reject(
                new PipelineAbort(
                  `stage exceeded stageTimeoutMs=${stageTimeoutMs}ms (uncooperative plugin?)`,
                ),
              ),
            stageTimeoutMs,
          );
        }),
      );
    }
    const outcome = await Promise.race(racers);
    return { outcome, durationMs: performance.now() - started, underlying };
  } catch (e: unknown) {
    if (isPipelineAbort(e)) {
      return {
        outcome: { ok: false, reason: e.message },
        durationMs: performance.now() - started,
        aborted: true,
        underlying,
      };
    }
    return {
      outcome: { ok: false, reason: "stage threw", cause: e },
      durationMs: performance.now() - started,
      thrown: e,
      underlying,
    };
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    if (abortListener !== undefined && signal !== undefined) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}
