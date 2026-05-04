/**
 * Process-local single-flight registry + caller-signal race helper.
 * Extracted from pipeline.ts in R37 to keep pipeline.ts under the
 * 800-line hard limit; semantics unchanged.
 */

import type { ForgeVerificationSummary, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";

/**
 * `InflightEntry` carries the shared leader promise AND a `detach` callback
 * the orchestrator invokes the moment a SECOND caller joins. The leader's
 * pipeline starts wired to the leader's own `AbortSignal` (so a solo
 * cache-backed run with no follower still aborts on caller cancellation).
 * As soon as a follower attaches, `detach()` unwires the leader's caller
 * signal — from that point the shared work runs to completion regardless
 * of the leader caller's abort, because some other caller is now relying
 * on it.
 */
export interface InflightEntry {
  readonly promise: Promise<Result<ForgeVerificationSummary>>;
  readonly detach: () => void;
  /**
   * The leader pipeline's internal signal (the one the stage loop
   * honors). Followers consult it before attaching — if it is already
   * aborted the leader pipeline is doomed, so a follower that joined
   * here would receive TIMEOUT despite never having aborted.
   */
  readonly leaderPipelineSignal: AbortSignal | undefined;
  /**
   * Registers a follower as a live consumer of the shared result.
   * Increments the leader's `liveConsumers` counter and (when
   * `followerSignal` is provided) wires an abort listener that
   * decrements when the follower itself aborts. Used by the
   * cache-write gate so a result no live caller actually accepted is
   * not persisted.
   */
  readonly registerConsumer: (followerSignal: AbortSignal | undefined) => void;
}

export const inflight: Map<string, InflightEntry> = new Map<string, InflightEntry>();

/**
 * Per-cache-instance identity for the single-flight key. Two callers
 * coalescing on the same composedKey but DIFFERENT cache backends or
 * DIFFERENT cacheReadFailure policies must not share a leader.
 */
const cacheIdentity = new WeakMap<object, string>();
let cacheIdSeq = 0;
export function cacheId(cache: object): string {
  const existing = cacheIdentity.get(cache);
  if (existing !== undefined) return existing;
  const id = `c${++cacheIdSeq}`;
  cacheIdentity.set(cache, id);
  return id;
}

/**
 * Race an in-flight leader promise against this caller's own AbortSignal.
 * If the signal fires first, return TIMEOUT to THIS caller — the leader
 * keeps running for other followers. If the leader resolves first, return
 * its result verbatim. Either way, no cross-caller leakage.
 */
export async function waitWithSignal(
  leader: Promise<Result<ForgeVerificationSummary>>,
  signal: AbortSignal,
): Promise<Result<ForgeVerificationSummary>> {
  if (signal.aborted) {
    return {
      ok: false,
      error: {
        code: "TIMEOUT",
        message: "Caller aborted while awaiting in-flight verification.",
        retryable: RETRYABLE_DEFAULTS.TIMEOUT,
        context: { stage: "<inflight>" },
      },
    };
  }
  return new Promise((resolve) => {
    const onAbort = (): void => {
      resolve({
        ok: false,
        error: {
          code: "TIMEOUT",
          message: "Caller aborted while awaiting in-flight verification.",
          retryable: RETRYABLE_DEFAULTS.TIMEOUT,
          context: { stage: "<inflight>" },
        },
      });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    leader.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        const detail = err instanceof Error ? err.message : "non-Error throw";
        resolve({
          ok: false,
          error: {
            code: "INTERNAL",
            message: `Leader pipeline threw: ${detail}`,
            retryable: RETRYABLE_DEFAULTS.INTERNAL,
            context: { stage: "<inflight>" },
            cause: err,
          },
        });
      },
    );
  });
}
