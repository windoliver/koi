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
 * `ForgeVerificationSummary` keyed by `options.cacheKey`. A cache hit
 * skips all stages.
 */
export async function runPipeline<I>(
  stages: readonly VerifierStage<I>[],
  artifact: I,
  options?: VerifyOptions,
): Promise<Result<ForgeVerificationSummary>> {
  const cacheKey = options?.cacheKey;
  const cache = options?.cache;
  const signal = options?.signal;

  if (cacheKey !== undefined && cache !== undefined) {
    const hit = await cache.get(cacheKey);
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

    const ctx: StageContext = {
      previous: digests,
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

  const summary: ForgeVerificationSummary = {
    passed: true,
    sandbox,
    totalDurationMs,
    stageResults: digests,
  };

  if (cacheKey !== undefined && cache !== undefined) {
    await cache.set(cacheKey, summary);
  }

  return { ok: true, value: summary };
}

function describeThrown(thrown: unknown): string {
  if (thrown instanceof Error) return thrown.message;
  if (typeof thrown === "string") return thrown;
  return "non-Error throw";
}
