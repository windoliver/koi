/**
 * runUntilPass — main convergence loop orchestration for @koi/loop.
 *
 * This file owns all side effects (timers, abort wiring, event emission,
 * collecting iteration records). The transition logic lives in
 * state-machine.ts; token accounting in budget.ts; prompt rebuilding in
 * rebuild-prompt.ts. Keeping this file focused on orchestration keeps the
 * decisions testable in isolation.
 */

import type { EngineEvent } from "@koi/core";
import { addTokens, extractIterationTokens } from "./budget.js";
import { defaultRebuildPrompt, normalizeVerifierResult } from "./rebuild-prompt.js";
import { nextTransition, type TransitionConfig } from "./state-machine.js";
import {
  type IterationRecord,
  LOOP_DEFAULTS,
  type LoopEvent,
  type LoopStatus,
  type RebuildPromptContext,
  type RunUntilPassConfig,
  type RunUntilPassResult,
  type TokenBudget,
  type Verifier,
  type VerifierResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

function validateConfig(config: RunUntilPassConfig): void {
  if (config.runtime === undefined || config.runtime === null) {
    throw new Error("runUntilPass: config.runtime is required");
  }
  if (config.verifier === undefined || config.verifier === null) {
    throw new Error("runUntilPass: config.verifier is required");
  }
  if (typeof config.initialPrompt !== "string" || config.initialPrompt.length === 0) {
    throw new Error("runUntilPass: config.initialPrompt must be a non-empty string");
  }
  if (typeof config.workingDir !== "string" || config.workingDir.length === 0) {
    throw new Error("runUntilPass: config.workingDir is required (no process.cwd() default)");
  }
  if (config.maxIterations !== undefined && config.maxIterations < 1) {
    throw new Error(`runUntilPass: maxIterations must be >= 1, got ${config.maxIterations}`);
  }
  if (
    typeof config.maxBudgetTokens === "number" &&
    (!Number.isFinite(config.maxBudgetTokens) || config.maxBudgetTokens < 1)
  ) {
    throw new Error(
      `runUntilPass: maxBudgetTokens must be a positive finite number or "unmetered", got ${config.maxBudgetTokens}`,
    );
  }
  if (config.maxConsecutiveFailures !== undefined && config.maxConsecutiveFailures < 1) {
    throw new Error(
      `runUntilPass: maxConsecutiveFailures must be >= 1, got ${config.maxConsecutiveFailures}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function combineSignals(parts: readonly (AbortSignal | undefined)[]): AbortSignal {
  const present = parts.filter((s): s is AbortSignal => s !== undefined);
  if (present.length === 0) return new AbortController().signal;
  if (present.length === 1) {
    // biome-ignore lint/style/noNonNullAssertion: length check above
    return present[0]!;
  }
  return AbortSignal.any(present);
}

/**
 * Run one agent turn. Returns a tuple: (events, done-seen, tokens, error).
 * Never throws — errors become `error` strings so the caller can build an
 * IterationRecord cleanly.
 */
async function runOneIteration(
  runtime: RunUntilPassConfig["runtime"],
  prompt: string,
  signal: AbortSignal,
): Promise<{
  readonly events: readonly EngineEvent[];
  readonly sawDone: boolean;
  readonly tokens: TokenBudget;
  readonly error: string | undefined;
  /**
   * True if iterator.return() exceeded the cleanup budget. The main loop
   * MUST treat this as a non-retriable terminal error — continuing to the
   * next iteration while an orphaned stream is still executing risks
   * duplicate side effects, concurrent mutations of shared state, and
   * other isolation violations. Fail closed.
   */
  readonly cleanupTimedOut: boolean;
}> {
  const events: EngineEvent[] = [];
  let sawDone = false;
  let error: string | undefined;

  // We drive the iterator explicitly (rather than for-await) so that on
  // abort we can call `iter.return?.()` to signal cancellation to the
  // runtime. Without that, a timed-out iteration's underlying stream keeps
  // running in the background and can still mutate shared state (e.g. the
  // CLI's engine-adapter transcript) after the next iteration has started.
  // That broke the clean-retry invariant even after the CLI-level
  // transcript reset. Cancelling the iterator via .return() is the only
  // reliable way to fence off an orphaned iteration.
  //
  // runtime.run() and the Symbol.asyncIterator lookup are BOTH guarded
  // against synchronous throws: a misbehaving LoopRuntime implementation
  // might throw before returning an AsyncIterable (e.g. null runtime,
  // config validation inside run(), a synchronous type error). Without
  // this try/catch the exception would escape runOneIteration and
  // propagate up to runUntilPass, bypassing the loop's terminal-state
  // contract.
  let iter: AsyncIterator<EngineEvent>;
  try {
    const iterable = runtime.run({ kind: "text", text: prompt, signal });
    iter = iterable[Symbol.asyncIterator]();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      events: [],
      sawDone: false,
      tokens: "unmetered",
      error: `runtime.run() threw before returning an AsyncIterable: ${message}`,
      cleanupTimedOut: false,
    };
  }

  let abortListener: (() => void) | undefined;
  let abortResolver: (() => void) | undefined;
  const abortPromise = new Promise<"aborted">((resolve) => {
    if (signal.aborted) {
      resolve("aborted");
      return;
    }
    abortResolver = (): void => resolve("aborted");
    abortListener = (): void => {
      abortResolver?.();
    };
    signal.addEventListener("abort", abortListener, { once: true });
  });

  try {
    // Explicit iterator drive so we can race iter.next() against abort
    // and call iter.return?.() in finally to cancel orphaned streams.
    for (;;) {
      const rawNext = iter.next();
      // Observe any rejection up front. If the abort race wins, the
      // losing nextPromise is never awaited again — and if the runtime
      // rejects it as part of cancellation cleanup, the rejection
      // would otherwise propagate as an unhandled-rejection at the
      // process level. Attaching this catch handler is a no-op on
      // successful resolution and swallows the rejection on failure.
      rawNext.catch(() => {
        // intentional: swallow — cancellation rejections are expected
      });
      const nextPromise = rawNext.then((r) => ({ kind: "next" as const, result: r }));
      const racedAbort = abortPromise.then(() => ({ kind: "abort" as const }));
      const raced = await Promise.race([nextPromise, racedAbort]);
      if (raced.kind === "abort") {
        error = "aborted";
        break;
      }
      const { result } = raced;
      if (result.done === true) break;
      const ev = result.value;
      events.push(ev);
      if (ev.kind === "done") {
        sawDone = true;
        // Engine stop reason must be "completed" — any other terminal
        // state (max_turns, interrupted, error) would otherwise silently
        // hand a truncated/partial turn to the verifier and could report
        // a false "converged". Single-prompt mode rejects these explicitly;
        // loop mode must match that contract.
        const stopReason = ev.output.stopReason;
        if (stopReason !== "completed") {
          error = `runtime turn ended with stopReason='${stopReason}' (expected 'completed')`;
          break;
        }
      }
    }
  } catch (err) {
    if (signal.aborted) {
      error = "aborted";
    } else {
      error = err instanceof Error ? err.message : String(err);
    }
  } finally {
    if (abortListener !== undefined) {
      signal.removeEventListener("abort", abortListener);
    }
  }

  // Fence off any orphaned iteration: signal cancellation via
  // iter.return(). For a real async generator, return() only resolves
  // after the generator regains control — and if the generator is
  // stuck in a non-abortable await (a wedged model stream, a hung
  // adapter) then awaiting return() would hang forever. So we race
  // return() against a tight cleanup budget. If cleanup misses the
  // budget the iterator is still running in the background, which
  // means the loop CANNOT safely retry — the main loop flags this as
  // a terminal errored state via cleanupTimedOut.
  //
  // Only fence on abort/error paths. A clean completion (stream drained
  // to its natural end, no abort signal) needs no cleanup because the
  // iterator has already finished. Fencing clean completions would make
  // every iteration pay the cleanup budget unnecessarily.
  //
  // Critical: if the iterator does NOT expose return() at all (the
  // structural LoopRuntime interface makes it optional), we cannot
  // positively signal cancellation and must treat that as cleanupTimedOut
  // on any abort/error path. A runtime that hands back a next-only
  // iterator cannot prove its background work stopped.
  let cleanupTimedOut = false;
  const needsCleanupFence = signal.aborted || error !== undefined;
  if (needsCleanupFence) {
    if (typeof iter.return !== "function") {
      // No cancellation hook at all — we cannot prove cleanup. Fail closed.
      cleanupTimedOut = true;
    } else {
      const cleanup = iter.return();
      if (cleanup === undefined) {
        // return() exists but doesn't return a promise — treat as
        // best-effort synchronous cleanup, not a cancellation guarantee.
        // This is uncommon for async iterators but permitted by the spec.
        cleanupTimedOut = true;
      } else {
        const CLEANUP_BUDGET_MS = 100;
        const CLEANUP_SENTINEL = Symbol("cleanup-timeout");
        try {
          const raced = await Promise.race([
            Promise.resolve(cleanup).then(
              () => undefined,
              () => undefined,
            ),
            new Promise<typeof CLEANUP_SENTINEL>((resolve) =>
              setTimeout(() => resolve(CLEANUP_SENTINEL), CLEANUP_BUDGET_MS),
            ),
          ]);
          if (raced === CLEANUP_SENTINEL) {
            cleanupTimedOut = true;
          }
        } catch {
          // cancellation must not re-throw, but if it did we treat it as
          // having completed — the iterator signalled via throw
        }
      }
    }
  } else {
    // Clean completion path: still call return() if present to release
    // generator resources. Swallow errors and do not block on cleanup —
    // if a well-behaved iterator's return() misbehaves on the clean path,
    // we've already returned a valid result.
    try {
      iter.return?.()?.catch(() => {
        // intentional
      });
    } catch {
      // intentional
    }
  }

  if (!sawDone && error === undefined) {
    error =
      events.length === 0
        ? "runtime.run produced zero events"
        : "runtime.run stream ended without a 'done' event";
  }
  if (cleanupTimedOut && error === undefined) {
    error = "iterator cleanup could not be guaranteed — orphaned stream may still be executing";
  }
  return {
    events,
    sawDone,
    tokens: extractIterationTokens(events),
    error,
    cleanupTimedOut,
  };
}

/**
 * Run the verifier with a timeout, converting thrown errors and timeouts
 * into typed VerifierResult failure variants.
 */
async function runVerifier(
  verifier: Verifier,
  iteration: number,
  workingDir: string,
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<{
  readonly result: VerifierResult;
  /**
   * True if the verifier's check() promise did not settle within the
   * cleanup budget after a timeout fired. The main loop MUST treat this
   * as a non-retriable terminal error — a verifier that's still executing
   * in the background can mutate files or external state while the next
   * iteration starts, and the loop has no way to prove isolation.
   */
  readonly cleanupTimedOut: boolean;
}> {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const signal = combineSignals([externalSignal, timeoutController.signal]);

  // Preemptive timeout: a non-cooperative verifier (one that ignores
  // ctx.signal, or hangs before it can observe the abort) would otherwise
  // block the loop forever despite the documented timeout contract. We
  // race verifier.check() against the timer + external signal so
  // runUntilPass can always return a terminal state.
  const timeoutSentinel = Symbol("verifier-timeout");
  const abortSentinel = Symbol("verifier-external-abort");
  type RaceResult = VerifierResult | typeof timeoutSentinel | typeof abortSentinel;

  // Track the external-signal listener so we can remove it after the race
  // settles. Without explicit cleanup, every verifier run would attach a
  // fresh listener to the shared externalSignal — long loops would stack
  // listeners and a late abort would fan out through stale closures.
  let externalAbortListener: (() => void) | undefined;
  const timeoutPromise = new Promise<RaceResult>((resolve) => {
    timeoutController.signal.addEventListener("abort", () => resolve(timeoutSentinel), {
      once: true,
    });
  });
  const externalAbortPromise = new Promise<RaceResult>((resolve) => {
    if (externalSignal === undefined) return;
    if (externalSignal.aborted) {
      resolve(abortSentinel);
      return;
    }
    externalAbortListener = (): void => resolve(abortSentinel);
    externalSignal.addEventListener("abort", externalAbortListener, { once: true });
  });

  const checkPromise: Promise<RaceResult> = (async () => {
    try {
      return await verifier.check({ iteration, workingDir, signal });
    } catch (err) {
      if (externalSignal?.aborted === true) return abortSentinel;
      if (timeoutController.signal.aborted) return timeoutSentinel;
      return {
        ok: false,
        reason: "predicate_threw",
        details: err instanceof Error ? err.message : String(err),
      };
    }
  })();

  try {
    const raced = await Promise.race([checkPromise, timeoutPromise, externalAbortPromise]);

    if (raced === timeoutSentinel) {
      // The timer fired. Give the verifier's own check() promise a
      // bounded grace period to finish cleaning up — argv-gate's
      // subprocess cleanup typically completes in a few ms after
      // signal abort, and most custom verifiers that honor the
      // signal will resolve quickly too. If check() doesn't settle
      // within the budget, the verifier is still running: we cannot
      // safely retry because the background work might still be
      // mutating files or external state. Flag cleanupTimedOut so
      // the main loop fails closed.
      const CLEANUP_BUDGET_MS = 500;
      const CLEANUP_SENTINEL = Symbol("verifier-cleanup-timeout");
      const settled = await Promise.race([
        checkPromise.then(
          () => "settled" as const,
          () => "settled" as const,
        ),
        new Promise<typeof CLEANUP_SENTINEL>((resolve) =>
          setTimeout(() => resolve(CLEANUP_SENTINEL), CLEANUP_BUDGET_MS),
        ),
      ]);
      const cleanupTimedOut = settled === CLEANUP_SENTINEL;
      return {
        result: {
          ok: false,
          reason: "timeout",
          details: cleanupTimedOut
            ? `verifier exceeded ${timeoutMs}ms timeout — check() did not settle within ${CLEANUP_BUDGET_MS}ms cleanup budget, retries are unsafe`
            : `verifier exceeded ${timeoutMs}ms timeout`,
        },
        cleanupTimedOut,
      };
    }
    if (raced === abortSentinel) {
      // Mirror the timeout path: even on external abort, give check()
      // a bounded grace period to settle. If it doesn't, the verifier
      // is still running in the background and retries would be unsafe.
      // Abort is typically initiated by a cooperating caller (SIGINT),
      // so most verifiers settle quickly — the fence catches the
      // pathological case where a custom verifier ignores ctx.signal.
      const CLEANUP_BUDGET_MS = 500;
      const CLEANUP_SENTINEL = Symbol("verifier-abort-cleanup-timeout");
      const settled = await Promise.race([
        checkPromise.then(
          () => "settled" as const,
          () => "settled" as const,
        ),
        new Promise<typeof CLEANUP_SENTINEL>((resolve) =>
          setTimeout(() => resolve(CLEANUP_SENTINEL), CLEANUP_BUDGET_MS),
        ),
      ]);
      const cleanupTimedOut = settled === CLEANUP_SENTINEL;
      return {
        result: {
          ok: false,
          reason: "aborted",
          details: cleanupTimedOut
            ? `verifier aborted by external signal — check() did not settle within ${CLEANUP_BUDGET_MS}ms cleanup budget, background work may still be executing`
            : "verifier aborted by external signal",
        },
        cleanupTimedOut,
      };
    }

    // Cooperative verifier path. Normalize + preserve timeout provenance if
    // the gate itself observed the abort and returned `aborted` in the
    // window before the timer sentinel resolved.
    const normalized = normalizeVerifierResult(raced);
    if (
      !normalized.ok &&
      normalized.reason === "aborted" &&
      timeoutController.signal.aborted &&
      externalSignal?.aborted !== true
    ) {
      return {
        result: {
          ok: false,
          reason: "timeout",
          details: `verifier exceeded ${timeoutMs}ms timeout`,
        },
        cleanupTimedOut: false,
      };
    }
    return { result: normalized, cleanupTimedOut: false };
  } finally {
    clearTimeout(timer);
    if (externalAbortListener !== undefined && externalSignal !== undefined) {
      externalSignal.removeEventListener("abort", externalAbortListener);
    }
  }
}

function emit(onEvent: RunUntilPassConfig["onEvent"], event: LoopEvent): void {
  if (onEvent === undefined) return;
  try {
    onEvent(event);
  } catch {
    // Listener errors must never corrupt the loop.
  }
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function runUntilPass(config: RunUntilPassConfig): Promise<RunUntilPassResult> {
  validateConfig(config);

  const maxIterations = config.maxIterations ?? LOOP_DEFAULTS.maxIterations;
  const maxBudgetTokens: TokenBudget = config.maxBudgetTokens ?? LOOP_DEFAULTS.maxBudgetTokens;
  const iterationTimeoutMs = config.iterationTimeoutMs ?? LOOP_DEFAULTS.iterationTimeoutMs;
  const verifierTimeoutMs = config.verifierTimeoutMs ?? LOOP_DEFAULTS.verifierTimeoutMs;
  const maxConsecutiveFailures =
    config.maxConsecutiveFailures ?? LOOP_DEFAULTS.maxConsecutiveFailures;
  const rebuildPrompt = config.rebuildPrompt ?? defaultRebuildPrompt;

  const transitionConfig: TransitionConfig = {
    maxIterations,
    maxBudgetTokens,
    maxConsecutiveFailures,
  };

  const startedAt = Date.now();
  const iterationRecords: IterationRecord[] = [];
  const recentFailures: VerifierResult[] = [];
  let tokensConsumed: TokenBudget = "unmetered";
  let consecutiveFailures = 0;
  let prompt = config.initialPrompt;

  // Pre-aborted signal: return immediately without running an iteration.
  if (config.signal?.aborted) {
    return finalize("aborted", "external abort signal fired before first iteration");
  }

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    if (config.signal?.aborted) {
      return finalize("aborted", "external abort signal fired");
    }

    emit(config.onEvent, { kind: "loop.iteration.start", iteration, prompt });

    // ── iterating phase ────────────────────────────────────────────────
    const iterStart = Date.now();
    const iterTimeout = new AbortController();
    const iterTimer = setTimeout(() => iterTimeout.abort(), iterationTimeoutMs);
    const iterSignal = combineSignals([config.signal, iterTimeout.signal]);

    const { events, tokens, error, cleanupTimedOut } = await runOneIteration(
      config.runtime,
      prompt,
      iterSignal,
    ).finally(() => clearTimeout(iterTimer));

    void events; // kept for future debug hooks; not otherwise referenced here

    // Cleanup budget exceeded → the underlying iterator MAY still be
    // running in the background. Fail closed: the loop cannot safely
    // start a new iteration while an orphan could still mutate shared
    // state or duplicate side-effecting tool calls. This is a
    // non-retriable terminal error regardless of verifier state.
    if (cleanupTimedOut) {
      recordErroredIteration(
        iteration,
        iterStart,
        tokens,
        "iterator cleanup timed out — cannot safely retry",
      );
      return finalize(
        "errored",
        "iterator cleanup timed out — orphaned stream may still be executing, retries are unsafe",
      );
    }

    // Token accounting (cumulative, post-iteration). Run the
    // accumulation FIRST so a failed/aborted iteration's already-
    // reported spend is not dropped from the running total. If the
    // iteration started a done event and then crashed/aborted before
    // a second turn could finish, those metered tokens are real spend
    // and must be counted. The order matters because the abort/error
    // branches below return early, short-circuiting whatever comes
    // after them.
    //
    // "unmetered" iterations (no done event) still yield tokens ===
    // "unmetered"; addTokens is a no-op in that case.
    if (typeof maxBudgetTokens === "number" && tokens !== "unmetered") {
      tokensConsumed = addTokens(tokensConsumed, tokens);
    }

    // Iteration phase aborted by external signal?
    // Check BEFORE the metered-budget guard so an aborted iteration is
    // reported as "aborted", not as a budget failure. An aborted
    // iteration typically has tokens === "unmetered" (no done event),
    // and running the budget check first would mask the real cause.
    if (config.signal?.aborted) {
      recordErroredIteration(iteration, iterStart, tokens, "aborted");
      return finalize("aborted", "external abort signal fired during iteration");
    }

    // Iteration timeout wins over a clean completion. If the timer
    // fired during the iteration, we cannot trust the completion even
    // if a done event arrived: it means the stream ran past its
    // budget, and races around the timer boundary would otherwise
    // make timeout enforcement non-deterministic (a late done event
    // could slip through and look successful). Checking the timeout
    // signal up front — before the error branch and the success
    // branch — ensures that any iteration whose clock ran out
    // terminates as errored regardless of what events the runtime
    // eventually produced.
    if (iterTimeout.signal.aborted && config.signal?.aborted !== true) {
      recordErroredIteration(
        iteration,
        iterStart,
        tokens,
        `iteration timeout (${iterationTimeoutMs}ms)`,
      );
      return finalize("errored", `runtime error: iteration timeout (${iterationTimeoutMs}ms)`);
    }

    // Iteration phase errored (zero events, no done, or stream threw)?
    // Same ordering rationale: an iteration timeout or runtime failure
    // typically has tokens === "unmetered", and the metered-budget
    // fail-closed guard below would otherwise hide the real cause
    // behind a generic budget error message.
    if (error !== undefined) {
      recordErroredIteration(iteration, iterStart, tokens, error);
      return finalize("errored", `runtime error: ${error}`);
    }

    // Hard-cap invariant: in metered mode, the loop cannot honor a
    // numeric budget if any iteration that otherwise completed cleanly
    // fails to report usage. Silently dropping unmetered iterations
    // from the cumulative total would let adapters with intermittent
    // usage reporting exceed the cap and still converge. Fail closed
    // instead — a clean iteration that reports no tokens under a
    // numeric cap becomes a terminal errored state rather than a
    // silent accounting hole.
    //
    // This check runs AFTER abort/error handling so a cancelled or
    // failed iteration is reported with its real cause, not as a
    // budget problem. (Accumulation already happened above for any
    // tokens that WERE reported.)
    if (typeof maxBudgetTokens === "number") {
      if (tokens === "unmetered") {
        recordErroredIteration(
          iteration,
          iterStart,
          tokens,
          `maxBudgetTokens=${maxBudgetTokens} set but iteration ${iteration} reported no token usage — hard cap cannot be honored`,
        );
        return finalize(
          "errored",
          `maxBudgetTokens=${maxBudgetTokens} set but iteration ${iteration} reported no token usage — the runtime's adapter does not populate EngineOutput.metrics.totalTokens, so the loop cannot enforce the budget. Use maxBudgetTokens: "unmetered" or switch to an adapter that reports usage`,
        );
      }

      // Short-circuit: if the agent iteration just blew through the hard
      // cap, do NOT run the verifier. A side-effecting verifier (argv
      // gate subprocess, custom predicate) would otherwise execute one
      // extra time after the stop condition has already been met — real
      // extra work and real extra spend after the loop has decided to
      // terminate. Record a synthetic iteration entry and finalize as
      // exhausted.
      if (typeof tokensConsumed === "number" && tokensConsumed >= maxBudgetTokens) {
        // Distinct "skipped_budget_exhausted" reason (not "aborted") so
        // per-iteration telemetry distinguishes budget-driven skips from
        // user-initiated cancellations. The iteration itself completed
        // successfully; the loop is terminating because the cumulative
        // budget hit the cap after adding this iteration's spend.
        const syntheticVerifier: VerifierResult = {
          ok: false,
          reason: "skipped_budget_exhausted",
          details: `maxBudgetTokens=${maxBudgetTokens} reached after iteration ${iteration} (consumed=${tokensConsumed}) — verifier skipped to avoid extra spend after the stop condition`,
        };
        recordIteration(iteration, iterStart, tokens, syntheticVerifier);
        return finalize(
          "exhausted",
          `maxBudgetTokens=${maxBudgetTokens} reached after iteration ${iteration} (consumed=${tokensConsumed}) — verifier skipped`,
        );
      }
    }

    // ── verifying phase ────────────────────────────────────────────────
    emit(config.onEvent, { kind: "loop.verifier.start", iteration });
    const { result: verifierResult, cleanupTimedOut: verifierCleanupTimedOut } = await runVerifier(
      config.verifier,
      iteration,
      config.workingDir,
      config.signal,
      verifierTimeoutMs,
    );
    emit(config.onEvent, {
      kind: "loop.verifier.complete",
      iteration,
      result: verifierResult,
    });

    // Aborted during verification?
    //
    // If the verifier already returned ok (convergence!), the loop
    // honors it and reports "converged" — a late-arriving abort did
    // not beat the successful result. Discarding a confirmed success
    // because the signal fired a few microseconds later would
    // confuse callers that cancelled only to stop further iterations.
    //
    // If the verifier failed AND the signal is aborted, that's a
    // real abort during verification: the agent's work did not
    // converge and the user cancelled before we could retry.
    if (config.signal?.aborted && !verifierResult.ok) {
      recordIteration(iteration, iterStart, tokens, verifierResult);
      // Promote to "errored" when the verifier's cleanup budget expired:
      // callers that see "aborted" may interpret it as a clean cancellation
      // and tear down temp state / start a new run while the old verifier's
      // background work is still mutating files. Only the clean-cancellation
      // case returns "aborted"; any evidence of live background work forces
      // a distinct terminal status.
      if (verifierCleanupTimedOut) {
        return finalize(
          "errored",
          "external abort signal fired during verification BUT verifier check() did not settle within cleanup budget — background work may still be executing, treating as errored so callers do not mistake this for a clean cancellation",
        );
      }
      return finalize("aborted", "external abort signal fired during verification");
    }

    recordIteration(iteration, iterStart, tokens, verifierResult);

    // Verifier cleanup timed out → fail closed. The verifier's check()
    // promise is still pending, which means background work (subprocess,
    // custom predicate) could still be mutating state. Continuing to
    // iteration N+1 while that work is in flight would violate the
    // loop's isolation contract. Matches the analogous iterator cleanup
    // timeout handling above.
    if (verifierCleanupTimedOut) {
      return finalize(
        "errored",
        "verifier cleanup timed out — check() still running, retries are unsafe",
      );
    }

    // Track recent failures for custom rebuilders.
    if (!verifierResult.ok) {
      recentFailures.push(verifierResult);
      while (recentFailures.length > LOOP_DEFAULTS.recentFailuresWindow) {
        recentFailures.shift();
      }
    }

    // ── transition ────────────────────────────────────────────────────
    const transition = nextTransition({
      phase: "verifying",
      iteration,
      consecutiveFailures,
      tokensConsumed,
      config: transitionConfig,
      verifierResult,
      runtimeError: undefined,
      aborted: false,
    });

    if (transition.kind === "terminal") {
      return finalize(transition.status, transition.reason);
    }

    // Continue: update state and build next prompt.
    consecutiveFailures = transition.nextConsecutiveFailures;
    const rebuildCtx: RebuildPromptContext = {
      iteration: transition.nextIteration,
      initialPrompt: config.initialPrompt,
      latestFailure: verifierResult, // always !ok here (converged → terminal)
      recentFailures: [...recentFailures],
      tokensConsumed,
    };
    try {
      prompt = rebuildPrompt(rebuildCtx);
    } catch (err) {
      // A broken rebuilder should not silently loop the same prompt.
      return finalize(
        "errored",
        `rebuildPrompt threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // If we fall out of the for-loop, it means maxIterations was hit via a
  // "continue" transition on the LAST iteration — but nextTransition should
  // have already returned "exhausted" for iteration == maxIterations. This
  // path is defensive only.
  return finalize("exhausted", `maxIterations=${maxIterations} reached (fallthrough)`);

  // ── closures ─────────────────────────────────────────────────────────
  function recordIteration(
    iteration: number,
    iterStart: number,
    tokens: TokenBudget,
    verifierResult: VerifierResult,
  ): void {
    const record: IterationRecord = {
      iteration,
      durationMs: Date.now() - iterStart,
      tokensConsumed: tokens,
      verifierResult,
    };
    iterationRecords.push(record);
    emit(config.onEvent, { kind: "loop.iteration.complete", record });
  }

  function recordErroredIteration(
    iteration: number,
    iterStart: number,
    tokens: TokenBudget,
    errorMessage: string,
  ): void {
    // The iteration failed before the verifier ran (abort, timeout,
    // zero events, missing done, cleanup timeout). Record it with the
    // distinct "runtime_error" verifier reason so callers can tell the
    // difference between "verifier said no" and "we never got to the
    // verifier". The runtimeError field carries the real message.
    //
    // Exception: external abort is its own distinct reason because it
    // is user-initiated cancellation, not a runtime fault.
    const reason = errorMessage === "aborted" ? "aborted" : "runtime_error";
    const record: IterationRecord = {
      iteration,
      durationMs: Date.now() - iterStart,
      tokensConsumed: tokens,
      verifierResult: {
        ok: false,
        reason,
        details: errorMessage,
      },
      runtimeError: errorMessage,
    };
    iterationRecords.push(record);
    emit(config.onEvent, { kind: "loop.iteration.complete", record });
  }

  function finalize(status: LoopStatus, reason: string): RunUntilPassResult {
    const result: RunUntilPassResult = {
      status,
      iterations: iterationRecords.length,
      tokensConsumed,
      durationMs: Date.now() - startedAt,
      iterationRecords: [...iterationRecords],
      terminalReason: reason,
    };
    emit(config.onEvent, { kind: "loop.terminal", result });
    return result;
  }
}
