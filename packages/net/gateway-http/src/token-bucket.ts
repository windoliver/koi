import type { RateLimitConfig } from "./types.js";

export interface TokenBucket {
  readonly tryConsume: (tokens: number) => boolean;
  readonly retryAfterMs: (tokens: number) => number;
}

export function createTokenBucket(
  config: RateLimitConfig,
  clock: () => number = Date.now,
): TokenBucket {
  let tokens = config.capacity;
  let lastRefill = clock();

  function refill(): void {
    const now = clock();
    const elapsedMs = Math.max(0, now - lastRefill);
    const add = (elapsedMs / 1000) * config.refillPerSec;
    if (add > 0) {
      tokens = Math.min(config.capacity, tokens + add);
      lastRefill = now;
    }
  }

  return {
    tryConsume(n) {
      refill();
      if (tokens >= n) {
        tokens -= n;
        return true;
      }
      return false;
    },
    retryAfterMs(n) {
      refill();
      const deficit = Math.max(0, n - tokens);
      if (deficit === 0) return 0;
      return Math.ceil((deficit / config.refillPerSec) * 1000);
    },
  };
}
