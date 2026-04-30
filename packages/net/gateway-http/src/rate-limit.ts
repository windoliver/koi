import { createLru, type Lru } from "./lru.js";
import { createTokenBucket, type TokenBucket } from "./token-bucket.js";
import type { RateLimitConfig } from "./types.js";

export type ConsumeResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterMs: number };

export interface RateLimitStore {
  readonly consumeSource: (sourceId: string, cfg: RateLimitConfig) => ConsumeResult;
  readonly consumeTenant: (
    channelId: string,
    tenantId: string,
    cfg: RateLimitConfig,
  ) => ConsumeResult;
}

export interface RateLimitStoreOptions {
  readonly clock?: () => number;
  /** Max distinct source IDs tracked. LRU-evicts oldest beyond this. */
  readonly sourceCapacity?: number;
  /** Max distinct (channel, tenant) pairs tracked. LRU-evicts oldest beyond this. */
  readonly tenantCapacity?: number;
}

const DEFAULT_SOURCE_CAPACITY = 50_000;
const DEFAULT_TENANT_CAPACITY = 50_000;

export function createRateLimitStore(
  optionsOrClock: RateLimitStoreOptions | (() => number) = {},
): RateLimitStore {
  const opts: RateLimitStoreOptions =
    typeof optionsOrClock === "function" ? { clock: optionsOrClock } : optionsOrClock;
  const clock = opts.clock ?? Date.now;
  // Bounded LRU prevents memory exhaustion when an attacker varies source IDs
  // (spray) or tenant IDs (auth-validated but high-cardinality). Eviction of an
  // idle bucket is safe — the next request from that key just refills a fresh
  // bucket at full capacity, which is the same behavior an attacker could
  // already obtain by waiting one refill cycle.
  const sourceBuckets: Lru<string, TokenBucket> = createLru(
    opts.sourceCapacity ?? DEFAULT_SOURCE_CAPACITY,
  );
  const tenantBuckets: Lru<string, TokenBucket> = createLru(
    opts.tenantCapacity ?? DEFAULT_TENANT_CAPACITY,
  );

  function getOrCreate(
    store: Lru<string, TokenBucket>,
    key: string,
    cfg: RateLimitConfig,
  ): TokenBucket {
    let b = store.get(key);
    if (b === undefined) {
      b = createTokenBucket(cfg, clock);
      store.set(key, b);
    }
    return b;
  }

  function consume(b: TokenBucket): ConsumeResult {
    if (b.tryConsume(1)) return { allowed: true };
    return { allowed: false, retryAfterMs: b.retryAfterMs(1) };
  }

  return {
    consumeSource(sourceId, cfg) {
      return consume(getOrCreate(sourceBuckets, sourceId, cfg));
    },
    consumeTenant(channelId, tenantId, cfg) {
      return consume(getOrCreate(tenantBuckets, `${channelId}:${tenantId}`, cfg));
    },
  };
}
