import type { ForgeStageDigest, ForgeVerificationSummary, KoiErrorCode, Result } from "@koi/core";
import { freezeSummary, isCachedSummaryConsistent, stageError } from "./cache-key.js";
import { createConsumerTracker } from "./consumer-tracker.js";
import { inflight, waitWithSignal } from "./inflight.js";
import { deriveInflightKey, setupPipelineSignal } from "./inflight-setup.js";
import { prepareSnapshot } from "./prepare-snapshot.js";
import { describeThrown, runStage } from "./run-stage.js";
import type { StageContext, VerifierStage, VerifyOptions } from "./types.js";
import { validateOptions } from "./validate-options.js";

/**
 * Sequential verification orchestrator.
 *
 * Runs each stage in order, recording its `ForgeStageDigest`. Stops at the
 * first `{ ok: false }` outcome and returns a `KoiError` carrying the
 * failing stage name. On full success, optionally caches the resulting
 * `ForgeVerificationSummary` keyed by `options.cacheKey` composed with a
 * stage-list fingerprint. A cache hit skips all stages.
 *
 * Cache writes are best-effort: a `cache.set` failure does not turn a
 * successful verification into a rejection. Cache reads, in contrast,
 * propagate (a read failure means we cannot prove the cache is empty, so
 * we must not silently re-run and risk a duplicate side effect from
 * stages — callers that want different semantics can wrap the cache).
 */
export async function runPipeline<I>(
  stages: readonly VerifierStage<I>[],
  artifact: I,
  options?: VerifyOptions,
): Promise<Result<ForgeVerificationSummary>> {
  const validated = validateOptions(stages, options);
  if (!validated.ok) return validated;
  const { cache, cacheReadFailure, signal, stageTimeoutMs } = validated.value;

  const prepared = prepareSnapshot(artifact, stages, validated.value, options);
  if (!prepared.ok) return prepared;
  const { snapshot, snapshotDigest, composedKey, declaredSandbox } = prepared.value;

  // Single-flight coalescing: if another caller is already verifying
  // the same key in this process, share its work. Cancellation is
  // per-WAITER (each caller races the shared promise against its own
  // signal); the leader pipeline runs independent of any caller's
  // signal so a single caller cannot abort side effects another caller
  // is awaiting. See inflight-setup.ts for key derivation rationale.
  const inflightKey = deriveInflightKey({
    stages,
    cache,
    cacheReadFailure,
    stageTimeoutMs,
    composedKey,
    snapshotDigest,
    options,
  });

  if (inflightKey !== undefined) {
    const existing = inflight.get(inflightKey);
    // Attach to the existing entry ONLY if the leader's pipeline
    // signal is not already aborted. A leader whose internal signal
    // has fired is doomed: its stage loop will short-circuit with
    // TIMEOUT on the next iteration. Letting an unaborted follower
    // attach would convert one caller's cancellation into another
    // caller's spurious failure — a particularly nasty under-load
    // race because it only appears in the narrow window between the
    // leader's abort and the stage loop noticing it. When the leader
    // is already doomed, evict the entry and become a fresh leader.
    // (The doomed leader's promise still settles to TIMEOUT for any
    // followers that already attached before the abort.)
    if (existing !== undefined) {
      if (existing.leaderPipelineSignal?.aborted === true) {
        inflight.delete(inflightKey);
      } else if (signal?.aborted === true) {
        // Follower is dead on arrival: do NOT detach the leader from
        // its own cancellation path (detach is irreversible and would
        // prevent the leader's abort from short-circuiting the shared
        // work even though no live consumer ever joined). Just return
        // a TIMEOUT directly without coalescing.
        return waitWithSignal(existing.promise, signal);
      } else {
        existing.detach();
        existing.registerConsumer(signal);
        if (signal === undefined) return existing.promise;
        return waitWithSignal(existing.promise, signal);
      }
    }
  }

  // Consumer tracker + pipeline-signal mirror: see consumer-tracker.ts
  // and inflight-setup.ts for the full rationale.
  const tracker = createConsumerTracker(signal);
  const { registerConsumer, releaseConsumerListeners } = tracker;
  const { pipelineSignal, detachCallerSignal } = setupPipelineSignal(signal, inflightKey);

  const work = async (): Promise<Result<ForgeVerificationSummary>> => {
    if (composedKey !== undefined && cache !== undefined) {
      if (pipelineSignal?.aborted) {
        return {
          ok: false,
          error: stageError("TIMEOUT", "<cache>", "Pipeline aborted before cache lookup."),
        };
      }
      let hit: Awaited<ReturnType<typeof cache.get>>;
      try {
        hit = await cache.get(composedKey);
      } catch (e: unknown) {
        // Cache read failure handling is policy: "miss" (default) treats the
        // outage as a cache miss and re-runs stages, so a degraded backend
        // cannot block all verification. "fail" returns INTERNAL inside the
        // Result envelope — appropriate when stages have non-idempotent side
        // effects and silent re-execution must be avoided. Either way, the
        // exception never escapes the documented Promise<Result<...>> contract.
        const detail = e instanceof Error ? e.message : "cache.get threw";
        if (cacheReadFailure === "fail") {
          return {
            ok: false,
            error: stageError("INTERNAL", "<cache>", `Cache read failed: ${detail}`, e),
          };
        }
        console.debug("[forge-verifier] cache.get failed, treating as miss:", e);
        hit = undefined;
      }
      if (pipelineSignal?.aborted) {
        return {
          ok: false,
          error: stageError("TIMEOUT", "<cache>", "Pipeline aborted during cache lookup."),
        };
      }
      if (
        hit !== undefined &&
        typeof hit === "object" &&
        hit !== null &&
        hit.key === composedKey &&
        isCachedSummaryConsistent(hit.summary, stages, declaredSandbox)
      ) {
        return {
          ok: true,
          value: freezeSummary({
            passed: hit.summary.passed,
            sandbox: declaredSandbox,
            totalDurationMs: hit.summary.totalDurationMs,
            stageResults: hit.summary.stageResults,
          }),
        };
      }
    }

    // let justified: digests accumulates immutably-replaced array as stages run.
    let digests: readonly ForgeStageDigest[] = [];
    let totalDurationMs = 0;

    for (const stage of stages) {
      if (pipelineSignal?.aborted === true) {
        return {
          ok: false,
          error: stageError("TIMEOUT", stage.name, `Pipeline aborted before stage "${stage.name}"`),
        };
      }

      // `previous` is documented as read-only, but the readonly modifier is a
      // compile-time fiction. A buggy or hostile stage could otherwise cast
      // it away and rewrite the recorded verification trail. Expose a frozen
      // shallow copy whose elements are themselves frozen.
      const ctx: StageContext = {
        previous: Object.freeze(digests.map((d) => Object.freeze({ ...d }))),
        ...(pipelineSignal !== undefined ? { signal: pipelineSignal } : {}),
      };
      const { outcome, durationMs, thrown, aborted, underlying } = await runStage(
        stage,
        snapshot,
        ctx,
        pipelineSignal,
        stageTimeoutMs,
      );
      // Suppress unhandled rejection on the underlying promise; the
      // race already returned what the caller sees, and we don't keep
      // a reference (the slot lifecycle no longer waits on it).
      void underlying.catch(() => undefined);
      totalDurationMs += durationMs;

      // Pipeline-initiated abort (caller signal OR per-stage watchdog)
      // short-circuits with TIMEOUT regardless of whether the underlying
      // stage promise has settled. The stage may continue running — we
      // cannot kill a Promise — but the caller is unblocked.
      if (aborted === true) {
        return {
          ok: false,
          error: stageError(
            "TIMEOUT",
            stage.name,
            `Stage "${stage.name}" ${outcome.ok ? "" : outcome.reason}`.trim(),
          ),
        };
      }

      // Validate the resolved outcome shape BEFORE any property destructure.
      // `VerifierStage` is a plugin boundary; a buggy implementation that
      // returns null/undefined/{} or a non-boolean `ok` must surface as a
      // typed Result error inside the envelope, not a TypeError that escapes
      // the documented `Promise<Result<...>>` contract.
      if (
        thrown === undefined &&
        (outcome === null || typeof outcome !== "object" || typeof outcome.ok !== "boolean")
      ) {
        return {
          ok: false,
          error: stageError(
            "INTERNAL",
            stage.name,
            `Stage "${stage.name}" returned a malformed outcome (expected { ok: boolean, ... }).`,
          ),
        };
      }

      if (!outcome.ok) {
        const code: KoiErrorCode = thrown !== undefined ? "INTERNAL" : "VALIDATION";
        const message =
          thrown !== undefined
            ? `Stage "${stage.name}" threw: ${describeThrown(thrown)}`
            : `Stage "${stage.name}" failed: ${outcome.reason}`;
        return {
          ok: false,
          error: stageError(code, stage.name, message, outcome.cause),
        };
      }

      if (outcome.sandboxed !== undefined && typeof outcome.sandboxed !== "boolean") {
        return {
          ok: false,
          error: stageError(
            "INTERNAL",
            stage.name,
            `Stage "${stage.name}" returned a non-boolean sandboxed value.`,
          ),
        };
      }
      // `sandboxed: true` is an attestation contract: a stage that declares
      // it MUST runtime-confirm by returning `outcome.sandboxed === true`.
      // Omission or `false` means the run did NOT enter the sandbox — the
      // trust bit cannot be set on metadata alone, otherwise a buggy or
      // malicious stage could silently skip isolation while downstream code
      // sees a sandbox-attested verification.
      if (stage.sandboxed === true && outcome.sandboxed !== true) {
        return {
          ok: false,
          error: stageError(
            "INVALID_CONFIG",
            stage.name,
            `Stage "${stage.name}" declares sandboxed=true but did not return outcome.sandboxed=true; runtime confirmation is required for sandbox attestation.`,
          ),
        };
      }
      // Inverse: a stage NOT statically sandboxed must not claim it ran
      // sandboxed — the cache key did not include the sandbox bit, so a
      // later identical stage list would alias to this run's pass.
      if (stage.sandboxed !== true && outcome.sandboxed === true) {
        return {
          ok: false,
          error: stageError(
            "INVALID_CONFIG",
            stage.name,
            `Stage "${stage.name}" returned sandboxed=true but is not statically declared sandboxed.`,
          ),
        };
      }

      digests = [...digests, { stage: stage.name, passed: true, durationMs }];

      // No post-stage abort check on purpose: if a stage already produced a
      // side effect (sandbox job, external API call, quota burn) and then
      // aborted, discarding the success and returning TIMEOUT would force
      // the caller to retry the same irreversible work. The pre-check at the
      // top of the next iteration still catches signals fired between
      // stages — pipeline ABORTS BEFORE starting un-run work, but COMMITS
      // work that already happened.
    }

    // Final abort gate: if the caller aborted while the LAST stage was in
    // flight, do not commit a passing summary or write it to cache. The
    // stage's side effect (if any) has already happened; discarding the
    // attestation is the safe asymmetry — a future run can re-attest, but
    // a cached "passed" we never returned to the caller cannot be undone.
    if (pipelineSignal?.aborted === true) {
      const lastStage = stages[stages.length - 1];
      const lastName = lastStage !== undefined ? lastStage.name : "<final>";
      return {
        ok: false,
        error: stageError(
          "TIMEOUT",
          lastName,
          "Pipeline aborted after final stage; result discarded and not cached.",
        ),
      };
    }

    // Freeze before either returning or caching so a caller-mutated summary
    // cannot poison the cache and a stage cannot rewrite the trail through a
    // retained reference.
    const summary = freezeSummary({
      passed: true,
      sandbox: declaredSandbox,
      totalDurationMs,
      stageResults: digests,
    });

    if (composedKey !== undefined && cache !== undefined) {
      // Suppress cache.set when no live consumer remains at the moment
      // the shared verification completes. `liveConsumers` starts at 1
      // for the leader and is incremented for each follower that
      // attaches; it decrements whenever a participating caller's
      // signal aborts. If every caller aborted before completion, no
      // live consumer ever accepted this result — caching it would
      // serve a "passed: true" entry that no participant actually
      // received.
      //
      // Drain pending microtasks first so any abort listeners that
      // fired synchronously while the stage loop was finishing have a
      // chance to decrement `liveConsumers` before we make the
      // suppression decision. (Without this yield, an abort that
      // raced the final stage's resolve could be missed.)
      await Promise.resolve();
      if (tracker.liveConsumers() === 0) {
        console.debug("[forge-verifier] cache.set suppressed (no live consumer)");
      } else {
        try {
          await cache.set(composedKey, { key: composedKey, summary });
          // Best-effort post-write check: if every consumer aborted
          // DURING the cache.set network round-trip, the write has
          // already committed (most cache backends do not expose
          // delete or signal-cancellation). Log so operators can
          // correlate the rare race; we cannot retract a committed
          // write without a delete API on `VerificationCache`. The
          // pre-write microtask drain above eliminates the common
          // synchronous-abort race; this only catches the in-flight
          // network case.
          if (tracker.liveConsumers() === 0) {
            console.debug(
              "[forge-verifier] cache.set committed but all consumers aborted during write (best-effort race)",
            );
          }
        } catch (e: unknown) {
          // Cache writes are best-effort. A backend outage must not flip a
          // successful verification into a rejection. Surface via console.debug
          // so operators can correlate; the next run will simply repopulate.
          console.debug("[forge-verifier] cache.set failed (ignored):", e);
        }
      }
    }

    return { ok: true, value: summary };
  };

  if (inflightKey !== undefined) {
    const key = inflightKey;
    // Register the leader entry BEFORE awaiting work so concurrent
    // followers coalesce. `detach` is invoked on first follower join
    // (see lookup branch above) and unwires the leader caller's signal
    // so the shared work is not killed by the leader's abort once
    // someone else depends on it.
    //
    // Release the in-flight slot as soon as `work()` settles. Earlier
    // revisions held the slot until every underlying stage promise also
    // settled, intending to deduplicate background work for an
    // uncooperative plugin. That choice bricked the key: once the
    // leader returned TIMEOUT, the wedged underlying could never settle
    // (by definition of "uncooperative"), and every subsequent caller
    // for the same artifact/context inherited the stale TIMEOUT for the
    // lifetime of the process — a soft DoS far worse than the
    // duplicated background work it prevented. The library's stated
    // contract for stageTimeoutMs already warns that the underlying
    // work may continue; honoring that contract by allowing fresh
    // verification attempts is the correct tradeoff. Followers that
    // joined while `work()` was running still share the leader's
    // result via the registered entry; only callers arriving AFTER
    // resolution become fresh leaders.
    const promise = work();
    const releaseSlot = promise.finally(() => {
      inflight.delete(key);
      releaseConsumerListeners();
      // Also unwire the leader's caller-signal mirror listener if no
      // follower ever attached (detachCallerSignal was never invoked
      // by a follower). Idempotent — safe to call again.
      detachCallerSignal();
    });
    void releaseSlot;
    inflight.set(key, {
      promise,
      detach: detachCallerSignal,
      leaderPipelineSignal: pipelineSignal,
      registerConsumer,
    });
    return signal !== undefined ? waitWithSignal(promise, signal) : promise;
  }
  // Solo path: still clean up listeners after work() settles so the
  // leader signal is not retained beyond the verification.
  return work().finally(releaseConsumerListeners);
}
