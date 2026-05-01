/**
 * Drain async-iterable runners with cooperative cancellation.
 *
 * Extracted so the orchestrator can reason about runner lifecycles
 * without inlining iterator-protocol bookkeeping.
 */

import { extractMessage } from "@koi/errors";

const ITERATOR_RETURN_TIMEOUT_MS = 5_000;

/**
 * Thrown when the runner's iterator.return() does not settle within the
 * grace window after abort/timeout. The runner is uncooperative — we must
 * fail the whole run rather than risk overlapping iterations.
 */
export class RunnerStuckError extends Error {
  override readonly name = "RunnerStuckError";
}

/** Drain an async iterable, racing each next() against an AbortSignal. */
export async function drainWithAbort(
  iterable: AsyncIterable<unknown>,
  signal: AbortSignal,
): Promise<void> {
  const iterator = iterable[Symbol.asyncIterator]();
  const abortPromise = makeAbortPromise(signal);

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
  if (exitedEarly) {
    await enforceCleanup(iterator);
  }
  if (drainError !== undefined) throw drainError;
}

function makeAbortPromise(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(new Error("Iteration aborted"));
      return;
    }
    signal.addEventListener("abort", () => reject(new Error("Iteration aborted")), { once: true });
  });
}

async function enforceCleanup(iterator: AsyncIterator<unknown>): Promise<void> {
  const returnFn = iterator.return;
  if (returnFn === undefined) {
    // No return() implementation — we have no way to signal the runner to
    // stop, and we cannot prove its work has finished. Continuing the
    // loop while a non-cooperative runner may still be mutating the
    // workspace produces overlapping iterations and side effects.
    // Require runners to implement return() for cancellable iteration.
    throw new RunnerStuckError(
      "VerifiedLoop: runner async iterator has no return() method — cannot confirm cancellation; aborting run to avoid overlapping iterations",
    );
  }
  // Use let — justified: race outcome flag.
  let timedOut = false;
  // Use let — justified: capture cleanup rejection.
  let cleanupError: unknown;
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
  if (timedOut) {
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
}
