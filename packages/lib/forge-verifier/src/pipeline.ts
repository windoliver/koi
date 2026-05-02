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
 * Deep-freeze a summary so neither callers nor any cache backend can hand
 * back mutable state. Applied to fresh results before returning AND to every
 * cache hit before it's trusted.
 */
function freezeSummary(summary: ForgeVerificationSummary): ForgeVerificationSummary {
  return Object.freeze({
    passed: summary.passed,
    sandbox: summary.sandbox,
    totalDurationMs: summary.totalDurationMs,
    stageResults: Object.freeze(summary.stageResults.map((d) => Object.freeze({ ...d }))),
  });
}

function fingerprintStages<I>(stages: readonly VerifierStage<I>[]): string {
  // JSON-encode so reserved characters in `name` or `version` cannot collide.
  return JSON.stringify(stages.map((s) => [s.name, s.version ?? "0"]));
}

function composeCacheKey<I>(
  namespace: string,
  artifactDigest: string,
  stages: readonly VerifierStage<I>[],
): string {
  // JSON-encode each component so neither namespace nor digest can contain a
  // separator that aliases a different (namespace, digest, stages) tuple.
  return JSON.stringify([namespace, artifactDigest, fingerprintStages(stages)]);
}

/**
 * Validate that a cached summary actually corresponds to the current stage
 * list. A corrupted, malicious, or stale cache backend can otherwise return
 * an empty `stageResults` array (or one with the wrong stage names) and the
 * pipeline would skip every check while reporting `passed: true`.
 */
function isCachedSummaryConsistent<I>(
  summary: ForgeVerificationSummary,
  stages: readonly VerifierStage<I>[],
): boolean {
  if (summary.passed !== true) return false;
  if (!Array.isArray(summary.stageResults)) return false;
  if (summary.stageResults.length !== stages.length) return false;
  for (let i = 0; i < stages.length; i++) {
    const expected = stages[i];
    const got = summary.stageResults[i];
    if (expected === undefined || got === undefined) return false;
    if (got.stage !== expected.name) return false;
    if (got.passed !== true) return false;
  }
  return true;
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
  options?: VerifyOptions<I>,
): Promise<Result<ForgeVerificationSummary>> {
  // Fail closed: a misconfigured caller, feature flag, or assembly bug
  // must NOT silently turn "no verifier configured" into "artifact passed".
  if (stages.length === 0) {
    return {
      ok: false,
      error: {
        code: "INVALID_CONFIG",
        message: "runPipeline requires at least one stage; refusing to fail-open.",
        retryable: RETRYABLE_DEFAULTS.INVALID_CONFIG,
      },
    };
  }

  const fingerprint = options?.artifactFingerprint;
  const namespace = options?.namespace ?? "";
  const cache = options?.cache;
  const signal = options?.signal;
  const composedKey =
    fingerprint !== undefined && cache !== undefined
      ? composeCacheKey(namespace, fingerprint(artifact), stages)
      : undefined;

  if (composedKey !== undefined && cache !== undefined) {
    const hit = await cache.get(composedKey);
    if (hit !== undefined && isCachedSummaryConsistent(hit, stages)) {
      // Normalize through freezeSummary so any cache backend (not just the
      // in-memory one) is held to the same immutability contract.
      return { ok: true, value: freezeSummary(hit) };
    }
    // Inconsistent or malformed hit — treat as a miss and re-verify.
    // (We do not write through here; the post-pipeline cache.set will.)
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

    // Re-check abort *after* every stage (including the last) and *before*
    // returning success. A long-running stage that finishes after the signal
    // fires must not be allowed to commit a pass result the caller has
    // already given up on. (`signal.aborted` is mutable; TS narrows on the
    // entry check above so we read it through the maybe-undefined wrapper.)
    if (signal?.aborted) {
      return {
        ok: false,
        error: stageError(
          "TIMEOUT",
          stage.name,
          `Pipeline aborted during or after stage "${stage.name}"`,
        ),
      };
    }
  }

  // Freeze before either returning or caching so a caller-mutated summary
  // cannot poison the cache and a stage cannot rewrite the trail through a
  // retained reference.
  const summary = freezeSummary({
    passed: true,
    sandbox,
    totalDurationMs,
    stageResults: digests,
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
