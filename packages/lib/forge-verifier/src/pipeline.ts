import type {
  ForgeStageDigest,
  ForgeVerificationSummary,
  KoiError,
  KoiErrorCode,
  Result,
} from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import type { StageContext, StageOutcome, VerifierStage, VerifyOptions } from "./types.js";

function stageError(code: KoiErrorCode, stage: string, message: string, cause?: unknown): KoiError {
  return {
    code,
    message,
    retryable: RETRYABLE_DEFAULTS[code],
    context: { stage },
    ...(cause !== undefined ? { cause } : {}),
  };
}

/**
 * Compose the cache key with a fingerprint of the stage list so that adding,
 * removing, or renaming a stage invalidates previously cached summaries.
 * A cache hit is only valid for the exact stage configuration that produced
 * it — otherwise version skew lets a prior pass result mask a now-failing
 * verification.
 */
function fingerprintStages<I>(stages: readonly VerifierStage<I>[]): string {
  return stages.map((s) => `${s.name}@${s.version ?? "0"}`).join("|");
}

function composeCacheKey<I>(userKey: string, stages: readonly VerifierStage<I>[]): string {
  return `${userKey}::${fingerprintStages(stages)}`;
}

async function runStage<I>(
  stage: VerifierStage<I>,
  artifact: I,
  ctx: StageContext,
): Promise<{
  readonly outcome: StageOutcome;
  readonly durationMs: number;
  readonly thrown?: unknown;
}> {
  const started = performance.now();
  try {
    const outcome = await stage.run(artifact, ctx);
    return { outcome, durationMs: performance.now() - started };
  } catch (e: unknown) {
    return {
      outcome: { ok: false, reason: "stage threw", cause: e },
      durationMs: performance.now() - started,
      thrown: e,
    };
  }
}

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
  const cacheKey = options?.cacheKey;
  const cache = options?.cache;
  const signal = options?.signal;
  const composedKey =
    cacheKey !== undefined && cache !== undefined ? composeCacheKey(cacheKey, stages) : undefined;

  if (composedKey !== undefined && cache !== undefined) {
    const hit = await cache.get(composedKey);
    if (hit !== undefined) {
      return { ok: true, value: hit };
    }
  }

  // let justified: digests accumulates immutably-replaced array as stages run;
  // sandbox folds in optional sandboxed flags from successful stage outcomes.
  let digests: readonly ForgeStageDigest[] = [];
  let sandbox = false;
  let totalDurationMs = 0;

  for (const stage of stages) {
    if (signal?.aborted === true) {
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
      ...(signal !== undefined ? { signal } : {}),
    };
    const { outcome, durationMs, thrown } = await runStage(stage, artifact, ctx);
    totalDurationMs += durationMs;

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

    digests = [...digests, { stage: stage.name, passed: true, durationMs }];
    if (outcome.sandboxed === true) {
      sandbox = true;
    }
  }

  // Freeze the summary and its digests before either returning or caching.
  // A caller that mutates the returned object cannot then poison the cache,
  // and a stage cannot reach back through the digest array to rewrite it.
  const summary: ForgeVerificationSummary = Object.freeze({
    passed: true,
    sandbox,
    totalDurationMs,
    stageResults: Object.freeze(digests.map((d) => Object.freeze({ ...d }))),
  });

  if (composedKey !== undefined && cache !== undefined) {
    try {
      await cache.set(composedKey, summary);
    } catch (e: unknown) {
      // Cache writes are best-effort. A backend outage must not flip a
      // successful verification into a rejection. Surface via console.debug
      // so operators can correlate; the next run will simply repopulate.
      console.debug("[forge-verifier] cache.set failed (ignored):", e);
    }
  }

  return { ok: true, value: summary };
}

function describeThrown(thrown: unknown): string {
  if (thrown instanceof Error) return thrown.message;
  if (typeof thrown === "string") return thrown;
  return "non-Error throw";
}
