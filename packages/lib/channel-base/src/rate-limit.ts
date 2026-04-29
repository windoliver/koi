/**
 * Rate-limit-aware send queue for channel adapters.
 *
 * Pauses the queue on 429 / rate-limit errors and retries
 * with exponential backoff. Errors from individual sends
 * are propagated to the caller; the queue keeps draining.
 */

import { computeBackoff, DEFAULT_RETRY_CONFIG, type RetryConfig, sleep } from "@koi/errors";

export interface RateLimiterConfig {
  /** Retry configuration for rate-limited sends. */
  readonly retry?: RetryConfig;
  /**
   * Extracts a retry-after delay (in ms) from a caught error.
   * Return undefined if the error is not a rate-limit error.
   */
  readonly extractRetryAfterMs?: (error: unknown) => number | undefined;
}

export interface RateLimiter {
  /** Enqueues a send. Resolves when the send completes (after any retries). */
  readonly enqueue: (fn: () => Promise<void>) => Promise<void>;
  /** Number of items waiting in the queue (excludes the in-flight item). */
  readonly size: () => number;
}

interface QueueEntry {
  readonly fn: () => Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

export function createRateLimiter(config?: RateLimiterConfig): RateLimiter {
  const retryConfig = config?.retry ?? DEFAULT_RETRY_CONFIG;
  const extractRetryAfterMs = config?.extractRetryAfterMs;

  // let justified: mutable queue state, immutable swap on each mutation
  let queue: readonly QueueEntry[] = [];
  // let justified: re-entrancy guard for the drain loop
  let processing = false;

  const drain = async (): Promise<void> => {
    if (processing) return;
    processing = true;

    while (queue.length > 0) {
      const [entry, ...rest] = queue;
      queue = rest;
      if (entry === undefined) continue;

      // let justified: tracks the last error across retry attempts
      let lastError: unknown;
      for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
        try {
          await entry.fn();
          lastError = undefined;
          break;
        } catch (error: unknown) {
          lastError = error;
          const retryAfterMs = extractRetryAfterMs?.(error);
          if (retryAfterMs !== undefined) {
            await sleep(retryAfterMs);
          } else if (attempt < retryConfig.maxRetries) {
            await sleep(computeBackoff(attempt, retryConfig));
          }
        }
      }

      if (lastError !== undefined) {
        entry.reject(lastError);
      } else {
        entry.resolve();
      }
    }

    processing = false;
  };

  return {
    enqueue: (fn: () => Promise<void>): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        queue = [...queue, { fn, resolve, reject }];
        void drain();
      }),
    size: (): number => queue.length,
  };
}
