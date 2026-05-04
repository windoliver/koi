/**
 * Eager validation of stages + VerifyOptions. Extracted from
 * pipeline.ts in R37 to keep pipeline.ts under the 400-line soft
 * limit; semantics unchanged. Returns either a typed config object
 * (everything pre-extracted from `options`) or a Result<never>
 * INVALID_CONFIG error envelope.
 */

import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import type { VerificationCache, VerifierStage, VerifyOptions } from "./types.js";

export interface ValidatedConfig {
  readonly namespace: string | undefined;
  readonly cache: VerificationCache | undefined;
  readonly cacheReadFailure: "fail" | "miss";
  readonly signal: AbortSignal | undefined;
  readonly stageTimeoutMs: number | undefined;
}

function configError(message: string): KoiError {
  return {
    code: "INVALID_CONFIG",
    message,
    retryable: RETRYABLE_DEFAULTS.INVALID_CONFIG,
  };
}

function fail<T>(message: string): Result<T> {
  return { ok: false, error: configError(message) };
}

export function validateOptions<I>(
  stages: readonly VerifierStage<I>[],
  options: VerifyOptions | undefined,
): Result<ValidatedConfig> {
  // Fail closed: a misconfigured caller, feature flag, or assembly bug
  // must NOT silently turn "no verifier configured" into "artifact passed".
  if (stages.length === 0) {
    return fail("runPipeline requires at least one stage; refusing to fail-open.");
  }

  // Validate stage descriptors up front: name must be a non-empty string,
  // and names must be unique. Without this, an empty-name stage would
  // produce a summary downstream consumers refuse to persist; duplicate
  // names break cache-key uniqueness and stage-result attribution.
  const seenNames = new Set<string>();
  for (let i = 0; i < stages.length; i++) {
    const s = stages[i];
    if (s === undefined || typeof s.name !== "string" || s.name.length === 0) {
      return fail(`Stage at index ${i} has invalid name (must be a non-empty string).`);
    }
    if (seenNames.has(s.name)) {
      return fail(`Duplicate stage name "${s.name}" at index ${i}; stage names must be unique.`);
    }
    seenNames.add(s.name);
  }

  const namespace = options?.namespace;
  const cache = options?.cache;
  const cacheReadFailure = options?.cacheReadFailure ?? "fail";
  const signal = options?.signal;
  const stageTimeoutMs = options?.stageTimeoutMs;

  // Validate stageTimeoutMs eagerly — silently coercing 0/negative/NaN
  // into "no timeout" turns a misconfiguration into the unbounded hang
  // this option exists to prevent. Fail closed.
  if (
    stageTimeoutMs !== undefined &&
    !(typeof stageTimeoutMs === "number" && Number.isFinite(stageTimeoutMs) && stageTimeoutMs > 0)
  ) {
    return fail(
      `VerifyOptions.stageTimeoutMs must be a finite positive number when set; got ${String(stageTimeoutMs)}.`,
    );
  }

  // When caching is enabled, every stage MUST declare an explicit non-empty
  // `version`. Two different plugin implementations sharing the same
  // (name, sandboxed) tuple but defaulting `version` to `"0"` would alias
  // each other in cache + single-flight slots — one plugin's pass could
  // satisfy another plugin's stage without its logic ever running.
  if (cache !== undefined) {
    for (let i = 0; i < stages.length; i++) {
      const s = stages[i];
      if (s === undefined) continue;
      if (typeof s.version !== "string" || s.version.length === 0) {
        return fail(
          `Stage "${s.name}" at index ${i} requires an explicit non-empty \`version\` when cache is provided; stage identity must distinguish plugin implementations.`,
        );
      }
    }
  }

  // Fail closed against silent cross-tenant replay: a shared cache backend
  // with two callers that both forget to set `namespace` would happily serve
  // each other's attestations whenever artifact content + stage metadata
  // match. Require an explicit non-empty namespace whenever cache is set.
  if (cache !== undefined && (typeof namespace !== "string" || namespace.length === 0)) {
    return fail(
      "VerifyOptions.namespace is required (non-empty string) when cache is provided; defaulting to '' would replay attestations across callers sharing the backend.",
    );
  }

  // Cache is NOT a security boundary — a backend that can write
  // structurally-correct envelopes can mint forged passes without any
  // stage running. Require every call site to explicitly acknowledge
  // that the supplied backend's write path is restricted to trusted
  // producers. Without this acknowledgment the cache is rejected.
  if (cache !== undefined && options?.acknowledgeTrustedCache !== true) {
    return fail(
      "VerifyOptions.cache requires acknowledgeTrustedCache: true. The cache is a TRUSTED storage optimization, not a security boundary — a backend that can write envelopes can forge passing attestations. Pass this flag only when the backend's write path is restricted to trusted producers.",
    );
  }

  // Require executionContextKey whenever results may be SHARED across
  // callers (cache + coalesceUncached). Stages may close over ambient
  // state (auth, tenant policy, feature flags); silently substituting
  // "" lets one caller's pass satisfy another caller's request that
  // would have evaluated different ambient context.
  const sharesResults = cache !== undefined || options?.coalesceUncached === true;
  const ctxRaw = options?.executionContextKey;
  if (sharesResults && (typeof ctxRaw !== "string" || ctxRaw.length === 0)) {
    return fail(
      "VerifyOptions.executionContextKey is required (non-empty string) when results may be shared across callers (cache or coalesceUncached). It partitions cache + single-flight by ambient stage context (auth, tenant policy, feature flags). Use a stable hash of any context the stage closures observe.",
    );
  }

  return {
    ok: true,
    value: { namespace, cache, cacheReadFailure, signal, stageTimeoutMs },
  };
}
