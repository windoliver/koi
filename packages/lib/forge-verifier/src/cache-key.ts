/**
 * Cache key composition + cached-summary validation + summary freezing
 * + KoiError factory. Extracted from pipeline.ts in R37 to keep
 * pipeline.ts under the 800-line hard limit; semantics unchanged.
 */

import type { ForgeVerificationSummary, KoiError, KoiErrorCode } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import type { VerifierStage } from "./types.js";

export function stageError(
  code: KoiErrorCode,
  stage: string,
  message: string,
  cause?: unknown,
): KoiError {
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
export function freezeSummary(summary: ForgeVerificationSummary): ForgeVerificationSummary {
  return Object.freeze({
    passed: summary.passed,
    sandbox: summary.sandbox,
    totalDurationMs: summary.totalDurationMs,
    stageResults: Object.freeze(summary.stageResults.map((d) => Object.freeze({ ...d }))),
  });
}

export function fingerprintStages<I>(stages: readonly VerifierStage<I>[]): string {
  // JSON-encode so reserved characters in `name` or `version` cannot collide.
  // `sandboxed` is part of the identity so flipping a stage from non-sandbox
  // to sandbox (without bumping `version`) cannot reuse old non-sandbox
  // cache entries and have them returned as `sandbox: true`.
  return JSON.stringify(stages.map((s) => [s.name, s.version ?? "0", s.sandboxed === true]));
}

export function composeCacheKey<I>(
  namespace: string,
  artifactDigest: string,
  stages: readonly VerifierStage<I>[],
  executionContextKey: string | undefined,
  stageTimeoutMs: number | undefined,
): string {
  // JSON-encode each component so reserved characters in any single
  // component cannot alias a different tuple. The execution-context
  // key is also folded in so two callers with the same artifact +
  // stages but different ambient context (auth, tenant policy, etc.)
  // do not share a cached pass. `stageTimeoutMs` is folded in too:
  // a permissive caller's success (stage took 500ms under a 1000ms
  // budget) must NOT satisfy a stricter caller (50ms budget) on a
  // cache hit — the stage would have timed out under the stricter
  // policy. Partitioning the key by normalized timeout prevents
  // policy drift across tenants/environments that share a backend.
  return JSON.stringify([
    namespace,
    artifactDigest,
    fingerprintStages(stages),
    executionContextKey ?? "",
    stageTimeoutMs !== undefined ? String(stageTimeoutMs) : "",
  ]);
}

function isFiniteNonNegative(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/**
 * Validate that a cached summary actually corresponds to the current stage
 * list AND trust posture. A corrupted, malicious, or stale cache backend
 * can otherwise return an empty `stageResults` array (or one with the wrong
 * stage names) and the pipeline would skip every check while reporting
 * `passed: true`. Also rejects entries whose stored `sandbox` claim differs
 * from the current static declaration — defense in depth: stage `sandboxed`
 * is already part of the cache key, so a divergence here means the backend
 * is replaying across keys it should never satisfy.
 */
export function isCachedSummaryConsistent<I>(
  summary: unknown,
  stages: readonly VerifierStage<I>[],
  declaredSandbox: boolean,
): summary is ForgeVerificationSummary {
  if (summary === null || typeof summary !== "object") return false;
  const s = summary as Record<string, unknown>;
  if (s.passed !== true) return false;
  if (s.sandbox !== declaredSandbox) return false;
  if (!isFiniteNonNegative(s.totalDurationMs)) return false;
  if (!Array.isArray(s.stageResults)) return false;
  if (s.stageResults.length !== stages.length) return false;
  for (let i = 0; i < stages.length; i++) {
    const expected = stages[i];
    const got = s.stageResults[i];
    if (expected === undefined || got === null || typeof got !== "object") return false;
    const d = got as Record<string, unknown>;
    if (d.stage !== expected.name) return false;
    if (d.passed !== true) return false;
    if (!isFiniteNonNegative(d.durationMs)) return false;
  }
  return true;
}
