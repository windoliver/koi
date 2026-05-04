/**
 * Single-flight key derivation + leader-signal mirror setup.
 * Extracted from pipeline.ts in R37 to keep pipeline.ts under the
 * 400-line soft limit; semantics unchanged.
 */

import { fingerprintStages } from "./cache-key.js";
import { cacheId } from "./inflight.js";
import type { VerificationCache, VerifierStage, VerifyOptions } from "./types.js";

/**
 * Derive the single-flight key for this run.
 *
 *   - Cached runs (cache + ack provided): always coalesce. Key
 *     includes cache identity, policy, timeout, executionContextKey,
 *     and composed key.
 *   - Uncached runs: only coalesce when the caller explicitly opts
 *     in via `coalesceUncached: true`.
 *   - Cyclic snapshots have no digest → cannot coalesce regardless.
 *
 * The key folds in cache backend identity, cacheReadFailure policy,
 * AND stageTimeoutMs so two callers coalesce only when they would
 * observe the same result. A trusted-cache caller MUST NOT inherit a
 * forged pass from an untrusted-cache caller, a `"fail"` caller MUST
 * NOT be dragged into a `"miss"` leader's silent re-execution after a
 * backend outage, and a strict-timeout caller MUST NOT inherit a
 * looser-timeout leader's safeguards.
 */
export function deriveInflightKey<I>(args: {
  readonly stages: readonly VerifierStage<I>[];
  readonly cache: VerificationCache | undefined;
  readonly cacheReadFailure: "fail" | "miss";
  readonly stageTimeoutMs: number | undefined;
  readonly composedKey: string | undefined;
  readonly snapshotDigest: string | undefined;
  readonly options: VerifyOptions | undefined;
}): string | undefined {
  const { stages, cache, cacheReadFailure, stageTimeoutMs, composedKey, snapshotDigest, options } =
    args;
  if (snapshotDigest === undefined) return undefined;
  const stageTimeoutKey = stageTimeoutMs !== undefined ? String(stageTimeoutMs) : "none";
  const ctxKey = options?.executionContextKey ?? "";
  if (composedKey !== undefined && cache !== undefined) {
    return `cached|${cacheId(cache)}|${cacheReadFailure}|${stageTimeoutKey}|${ctxKey}|${composedKey}`;
  }
  if (options?.coalesceUncached === true) {
    return `uncached|${cacheReadFailure}|${stageTimeoutKey}|${ctxKey}|${fingerprintStages(stages)}|${snapshotDigest}`;
  }
  return undefined;
}

export interface PipelineSignalSetup {
  readonly pipelineSignal: AbortSignal | undefined;
  readonly detachCallerSignal: () => void;
}

/**
 * Build the signal the stage loop honors:
 *   - Solo run (no inflightKey): caller's own signal — straightforward.
 *   - Cache-backed run with possible coalescing: start with an internal
 *     mirror of the caller's signal so a SOLO caller still aborts the
 *     work. When a follower joins, `detachCallerSignal()` unwires the
 *     mirror so the leader's signal no longer aborts the shared work.
 */
export function setupPipelineSignal(
  signal: AbortSignal | undefined,
  inflightKey: string | undefined,
): PipelineSignalSetup {
  if (inflightKey === undefined) {
    return { pipelineSignal: signal, detachCallerSignal: () => {} };
  }
  if (signal === undefined) {
    return { pipelineSignal: undefined, detachCallerSignal: () => {} };
  }
  const internal = new AbortController();
  if (signal.aborted) {
    internal.abort();
    return { pipelineSignal: internal.signal, detachCallerSignal: () => {} };
  }
  const onAbort = (): void => internal.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  return {
    pipelineSignal: internal.signal,
    detachCallerSignal: () => signal.removeEventListener("abort", onAbort),
  };
}
