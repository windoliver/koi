import type { ForgeVerificationSummary } from "@koi/core";
import type { VerificationCache } from "./types.js";

/**
 * Trivial in-process cache. Unbounded — production callers should plug in an
 * LRU or external store via the `VerificationCache` interface.
 */
export function createMemoryCache(): VerificationCache {
  const store = new Map<string, ForgeVerificationSummary>();
  return {
    get: (key) => store.get(key),
    set: (key, summary) => {
      store.set(key, summary);
    },
  };
}
