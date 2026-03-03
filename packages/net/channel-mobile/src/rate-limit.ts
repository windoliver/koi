/**
 * Simple sliding-window rate limiter per client.
 *
 * OpenClaw pattern: per-device rate limiting with lockout to prevent
 * message flooding from mobile clients.
 */

/** Rate limiter configuration. */
export interface RateLimitConfig {
  /** Maximum messages allowed in the window. */
  readonly maxMessages: number;
  /** Window duration in milliseconds. */
  readonly windowMs: number;
}

/** Default: 30 messages per 60 seconds. */
export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  maxMessages: 30,
  windowMs: 60_000,
} as const;

/** Result of a rate limit check. */
export interface RateLimitResult {
  readonly allowed: boolean;
  /** Milliseconds until the client can send again (0 if allowed). */
  readonly retryAfterMs: number;
}

/**
 * Creates a rate limiter that tracks message timestamps per client.
 */
export function createRateLimiter(config: RateLimitConfig = DEFAULT_RATE_LIMIT): {
  readonly check: (clientId: string) => RateLimitResult;
  readonly reset: (clientId: string) => void;
  readonly resetAll: () => void;
} {
  // let: mutable map of client timestamps, managed by check/reset lifecycle
  const windows = new Map<string, number[]>();

  return {
    check: (clientId: string): RateLimitResult => {
      const now = Date.now();
      const cutoff = now - config.windowMs;

      // Get or create window for this client
      const timestamps = windows.get(clientId) ?? [];
      // Filter to only timestamps within the window
      const recent = timestamps.filter((t) => t > cutoff);

      if (recent.length >= config.maxMessages) {
        // Find the oldest timestamp in the window to compute retry-after
        const oldest = recent[0] ?? now;
        const retryAfterMs = oldest + config.windowMs - now;
        // Update stored timestamps (pruned)
        windows.set(clientId, recent);
        return { allowed: false, retryAfterMs: Math.max(0, retryAfterMs) };
      }

      // Allowed — record this timestamp
      windows.set(clientId, [...recent, now]);
      return { allowed: true, retryAfterMs: 0 };
    },

    reset: (clientId: string): void => {
      windows.delete(clientId);
    },

    resetAll: (): void => {
      windows.clear();
    },
  };
}
