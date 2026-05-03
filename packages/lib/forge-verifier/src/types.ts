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
 * Pluggable cache for successful verification summaries. Both methods return
 * `T | Promise<T>` so an in-memory `Map` and a remote KV expose the same
 * surface. Failed pipelines are intentionally not cached.
 */
export interface VerificationCache {
  readonly get: (
    key: string,
  ) => ForgeVerificationSummary | undefined | Promise<ForgeVerificationSummary | undefined>;
  readonly set: (key: string, summary: ForgeVerificationSummary) => void | Promise<void>;
}

/**
 * Caller-supplied function that derives a content fingerprint from the
 * artifact under verification. The library composes this with the stage
 * fingerprint AND an optional namespace to form the actual cache key, so
 * the cache can never serve one artifact's pass to a different artifact
 * (assuming a content-derived fingerprint — the runtime cannot prove
 * function purity, so callers MUST return a value that varies with
 * artifact content; a constant or external label is a contract violation).
 */
export type ArtifactFingerprintFn<I> = (artifact: I) => string;

export interface VerifyOptions<I = unknown> {
  /**
   * Derive a content fingerprint from the artifact. Required for any
   * caching to occur. A library-side composeKey wraps this with the
   * stage list and namespace so callers can return just the artifact
   * digest.
   */
  readonly artifactFingerprint?: ArtifactFingerprintFn<I> | undefined;
  /**
   * Optional caller namespace folded into the cache key. Use this to
   * partition the cache by tenant, environment, or verifier suite. Defaults
   * to the empty string.
   */
  readonly namespace?: string | undefined;
  readonly cache?: VerificationCache | undefined;
  readonly signal?: AbortSignal | undefined;
}
