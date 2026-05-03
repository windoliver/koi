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
 * `version` is REQUIRED and participates in the cache fingerprint. Two
 * stages with the same `name` but different `version` produce different
 * cache keys, so tightening a stage's logic without renaming it
 * invalidates prior cached pass results. Bump it whenever the stage's
 * check semantics change in a way callers should re-verify. Required
 * (rather than optional with a default) because two different plugin
 * implementations sharing the same `(name, sandboxed)` tuple but each
 * defaulting `version` would alias each other in the cache and the
 * single-flight slot — one plugin's pass could satisfy another plugin's
 * stage without its logic ever running. Forcing each stage author to
 * make a deliberate version claim eliminates that class of false
 * positive at compile time.
 *
 * `sandboxed` declares (statically) whether the stage executes the artifact
 * inside an isolation boundary. The orchestrator uses this — NOT the cached
 * `sandbox` field — to compute the returned summary's `sandbox` bit on
 * cache hits, so a divergent cached `sandbox` value cannot bypass the
 * current stage list's declarations. (The cache is a trusted storage
 * optimization, not a security boundary — see `VerificationCache` for the
 * full trust contract.)
 */
export interface VerifierStage<I = unknown> {
  readonly name: string;
  readonly version: string;
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
 * TRUST MODEL — IMPORTANT
 * -----------------------
 * The cache is a TRUSTED storage optimization, NOT a security boundary. The
 * verifier validates structural shape (key binding, stage names, finite
 * durations, sandbox-vs-declaration agreement) on read so a buggy or stale
 * backend cannot pass through obvious garbage. It does NOT authenticate the
 * payload — a hostile backend that mints a structurally-correct
 * `CachedVerification` envelope CAN cause the verifier to report `passed:
 * true` for an artifact that was never run. Callers that need
 * tamper-resistance MUST use a backend whose write path is restricted to
 * trusted producers (process-local memory, a tenant-isolated KV with
 * authenticated writes, etc.). For untrusted-storage scenarios, layer a
 * signed/HMAC'd envelope above this interface — the library does not
 * provide that out of the box.
 *
 * The verifier wraps every value in a `CachedVerification` envelope. Backends
 * MUST round-trip the envelope verbatim — they MUST NOT serve a value with a
 * different `key` than was requested. The verifier verifies this on read and
 * treats key mismatches as a miss; this is correctness defense, not auth.
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
  /**
   * Explicit acknowledgment that the supplied `cache` backend is trusted.
   * REQUIRED when `cache` is provided — without it the verifier refuses
   * to ship cached pass results.
   *
   * The cache is NOT a security boundary (see `VerificationCache` for the
   * full trust model). A backend that can write structurally-correct
   * envelopes can mint passing attestations without any stage running.
   * Forcing every call site to pass `acknowledgeTrustedCache: true`
   * makes the trust decision visible in code review and grep, instead of
   * hiding it behind a default. Set this only when the cache backend's
   * write path is restricted to trusted producers (process-local memory,
   * a tenant-isolated KV with authenticated writes, etc.).
   */
  readonly acknowledgeTrustedCache?: true | undefined;
  /**
   * Per-stage hard timeout in milliseconds. When a stage's `run` does not
   * resolve within this window, the pipeline returns TIMEOUT to the caller
   * even if the stage's promise has not settled — the underlying work
   * may continue (we cannot kill a JS Promise), but the caller is no
   * longer blocked by an uncooperative plugin that ignores `ctx.signal`.
   * Defaults to `undefined` (no per-stage cap; rely only on `signal`).
   * Recommended in production where stage authors are not fully trusted.
   */
  readonly stageTimeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}
