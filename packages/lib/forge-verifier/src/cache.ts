import type { ForgeVerificationSummary } from "@koi/core";
import type { CachedVerification, VerificationCache } from "./types.js";

/**
 * Defensively copy a summary so the cache never shares object identity with
 * caller-owned data. Without this, a caller mutating the returned summary
 * (e.g. appending diagnostic fields downstream) would poison the cache and
 * be replayed as a trusted hit on later runs.
 */
function snapshot(summary: ForgeVerificationSummary): ForgeVerificationSummary {
  return Object.freeze({
    passed: summary.passed,
    sandbox: summary.sandbox,
    totalDurationMs: summary.totalDurationMs,
    stageResults: Object.freeze(summary.stageResults.map((d) => Object.freeze({ ...d }))),
  });
}

/**
 * Trivial in-process cache. Unbounded — production callers should plug in an
 * LRU or external store via the `VerificationCache` interface.
 *
 * Stored summaries are deep-frozen on `set` so neither the writer nor any
 * later reader can mutate the cache through a shared reference. The envelope
 * `key` is preserved verbatim so the verifier's read-side key check passes.
 */
export function createMemoryCache(): VerificationCache {
  const store = new Map<string, CachedVerification>();
  return {
    get: (key) => store.get(key),
    set: (key, value) => {
      store.set(key, Object.freeze({ key: value.key, summary: snapshot(value.summary) }));
    },
  };
}
