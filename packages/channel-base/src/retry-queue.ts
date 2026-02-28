/**
 * Rate-limit-aware send queue for channel adapters.
 *
 * Pauses the queue on 429 / rate-limit errors and retries
 * with exponential backoff. Errors from individual sends
 * are propagated to the caller.
 */

import type { RetryConfig } from "@koi/errors";
import { computeBackoff, DEFAULT_RETRY_CONFIG, sleep } from "@koi/errors";

export interface RetryQueueConfig {
  /** Retry configuration for rate-limited sends. */
  readonly retry?: RetryConfig;
  /**
   * Extracts a retry-after delay (in ms) from a caught error.
   * Return undefined if the error is not a rate-limit error.
   */
  readonly extractRetryAfterMs?: (error: unknown) => number | undefined;
}

export interface RetryQueue {
  /** Enqueues a send function. Resolves when the send completes (after any retries). */
  readonly enqueue: (fn: () => Promise<void>) => Promise<void>;
  /** Returns the number of items waiting in the queue. */
  readonly size: () => number;
}

/**
 * Creates a rate-limit-aware send queue.
 *
 * Sends are executed sequentially. On a rate-limit error the queue
 * pauses for the retry-after duration (or computed backoff) before
 * retrying.
 */
export function createRetryQueue(config?: RetryQueueConfig): RetryQueue {
  const retryConfig = config?.retry ?? DEFAULT_RETRY_CONFIG;
  const extractRetryAfterMs = config?.extractRetryAfterMs;

  // let justified: mutable queue state
  let queue: readonly (() => Promise<void>)[] = [];
  let processing = false;

  const processQueue = async (): Promise<void> => {
    if (processing) return;
    processing = true;

    while (queue.length > 0) {
      const [fn, ...rest] = queue;
      queue = rest;

      if (fn !== undefined) {
        let lastError: unknown;

        for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
          try {
            await fn();
            lastError = undefined;
            break;
          } catch (error: unknown) {
            lastError = error;

            const retryAfterMs = extractRetryAfterMs?.(error);
            if (retryAfterMs !== undefined) {
              // Rate-limited: pause for the specified duration
              await sleep(retryAfterMs);
            } else if (attempt < retryConfig.maxRetries) {
              const delay = computeBackoff(attempt, retryConfig);
              await sleep(delay);
            }
          }
        }

        if (lastError !== undefined) {
          // Final attempt failed — propagate but continue processing queue
          processing = false;
          throw lastError;
        }
      }
    }

    processing = false;
  };

  return {
    enqueue: async (fn: () => Promise<void>): Promise<void> => {
      queue = [...queue, fn];
      await processQueue();
    },

    size: (): number => queue.length,
  };
}
