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

export function createRateLimitStore(clock: () => number = Date.now): RateLimitStore {
  const sourceBuckets = new Map<string, TokenBucket>();
  const tenantBuckets = new Map<string, TokenBucket>();

  function getOrCreate(
    map: Map<string, TokenBucket>,
    key: string,
    cfg: RateLimitConfig,
  ): TokenBucket {
    let b = map.get(key);
    if (b === undefined) {
      b = createTokenBucket(cfg, clock);
      map.set(key, b);
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
