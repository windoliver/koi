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
 */
export interface VerifierStage<I = unknown> {
  readonly name: string;
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

export interface VerifyOptions {
  readonly cacheKey?: string | undefined;
  readonly cache?: VerificationCache | undefined;
  readonly signal?: AbortSignal | undefined;
}
