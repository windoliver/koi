/**
 * Public contracts for the forge-verifier pipeline.
 *
 * The orchestrator (`runPipeline`) owns sequencing, timing, short-circuit,
 * and cache plumbing. Stages own only the per-artifact check.
 */

import type { ForgeStageDigest, ForgeVerificationSummary } from "@koi/core";

/**
 * Read-only context handed to every stage. `previous` lets a later stage
 * inspect what earlier stages produced (e.g., a self-test stage may want to
 * know whether a sandbox stage already ran). `signal` propagates cancellation
 * from `VerifyOptions.signal`.
 */
export interface StageContext {
  readonly previous: readonly ForgeStageDigest[];
  readonly signal?: AbortSignal | undefined;
}

/**
 * Outcome of a single stage. `sandboxed: true` on success advertises that
 * the stage executed the artifact inside an isolation boundary; the
 * orchestrator OR-folds this into `ForgeVerificationSummary.sandbox`.
 */
export type StageOutcome =
  | { readonly ok: true; readonly sandboxed?: boolean | undefined }
  | { readonly ok: false; readonly reason: string; readonly cause?: unknown };

/**
 * Extension point. To add a new stage, write a `VerifierStage` value and
 * pass it into the `stages` array — no edits to `runPipeline`.
 *
 * `version` participates in the cache fingerprint. Two stages with the same
 * `name` but different `version` produce different cache keys, so tightening
 * a stage's logic without renaming it invalidates prior cached pass results.
 * Defaults to `"0"` when omitted; bump it whenever the stage's check
 * semantics change in a way callers should re-verify.
 *
 * `sandboxed` declares (statically) whether the stage executes the artifact
 * inside an isolation boundary. The orchestrator uses this — NOT the cached
 * `sandbox` field — to compute the returned summary's `sandbox` bit on
 * cache hits. A hostile cache backend cannot forge `sandbox: true` because
 * the value is recomputed from declared stage capabilities on every return.
 */
export interface VerifierStage<I = unknown> {
  readonly name: string;
  readonly version?: string | undefined;
  readonly sandboxed?: boolean | undefined;
  readonly run: (artifact: I, ctx: StageContext) => StageOutcome | Promise<StageOutcome>;
}

/**
 * Envelope stored in the cache. The `key` field binds the payload to the
 * exact `(namespace, artifactFingerprint, stages)` tuple it was computed
 * from, so a buggy or stale backend that returns a value for the wrong key
 * is detected at read time and treated as a miss.
 */
export interface CachedVerification {
  readonly key: string;
  readonly summary: ForgeVerificationSummary;
}

/**
 * Pluggable cache for successful verification summaries. Both methods return
 * `T | Promise<T>` so an in-memory `Map` and a remote KV expose the same
 * surface. Failed pipelines are intentionally not cached.
 *
 * The verifier wraps every value in a `CachedVerification` envelope. Backends
 * MUST round-trip the envelope verbatim — they MUST NOT serve a value with a
 * different `key` than was requested. The verifier verifies this on read and
 * treats key mismatches as a miss.
 */
export interface VerificationCache {
  readonly get: (
    key: string,
  ) => CachedVerification | undefined | Promise<CachedVerification | undefined>;
  readonly set: (key: string, value: CachedVerification) => void | Promise<void>;
}

export interface VerifyOptions {
  /**
   * Caller namespace folded into the cache key. REQUIRED when `cache` is
   * provided — partitions the cache by tenant, environment, or verifier
   * suite so two callers sharing a backend cannot replay each other's
   * attestations. Must be a non-empty string. Use a constant per (tenant,
   * environment) pair; the value is opaque to the verifier.
   */
  readonly namespace?: string | undefined;
  /**
   * Pluggable cache. The library derives the artifact's contribution to
   * the cache key INTERNALLY from the validated frozen snapshot — no caller
   * callback runs on the verifier stack. If the snapshot cannot be
   * deterministically serialized (e.g., contains cycles), the cache is
   * silently bypassed for that run rather than served a non-bound key.
   */
  readonly cache?: VerificationCache | undefined;
  /**
   * Behavior when `cache.get` throws (transient backend outage, etc.).
   *
   *   - `"fail"` (default): return INTERNAL inside the Result envelope.
   *     Safe at this boundary — `VerifierStage.run` is pluggable and the
   *     library cannot know whether stages are idempotent. Silently
   *     re-executing them on a backend outage could double-charge external
   *     APIs, re-run sandbox jobs, or burn quota.
   *   - `"miss"`: treat as a cache miss and re-run stages. Opt-in for
   *     pipelines whose stages are KNOWN to be pure / side-effect free
   *     (e.g. read-only schema validation); a degraded cache then
   *     degrades gracefully instead of blocking verification.
   */
  readonly cacheReadFailure?: "miss" | "fail" | undefined;
  readonly signal?: AbortSignal | undefined;
}
