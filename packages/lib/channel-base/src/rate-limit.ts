/**
 * Rate-limit-aware send queue for channel adapters.
 *
 * Sequential FIFO queue. Pauses on rate-limit errors and retries with
 * exponential backoff. Defaults honor `KoiError` retry metadata: a
 * `KoiError` with `retryAfterMs` set, `retryable: true`, or a code that
 * `@koi/errors.isRetryable()` classifies as retryable will be retried.
 * Callers can override either policy hook for transports that need
 * different semantics. Non-`KoiError` exceptions reject immediately so
 * non-idempotent sends are never re-issued.
 */

import {
  computeBackoff,
  DEFAULT_RETRY_CONFIG,
  isKoiError,
  isRetryable as isKoiRetryable,
  type RetryConfig,
  sleep,
} from "@koi/errors";

export interface RateLimiterConfig {
  /** Retry configuration for rate-limited sends. */
  readonly retry?: RetryConfig;
  /**
   * Extracts a retry-after delay (in ms) from a caught error.
   * Return undefined if the error does not carry a retry hint.
   * Defaults to reading `error.retryAfterMs` when the error is a `KoiError`.
   * A defined value also classifies the error as retryable.
   */
  readonly extractRetryAfterMs?: (error: unknown) => number | undefined;
  /**
   * Decides whether a non-rate-limit error should be retried.
   * Defaults to honoring `KoiError` retry semantics — `error.retryable` true
   * or a code in the retryable set per `@koi/errors.isRetryable()`. Override
   * for transports that need different rules; passing `() => false` opts
   * out of any retry that is not driven by an explicit retry-after.
   */
  readonly isRetryable?: (error: unknown) => boolean;
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

const defaultExtractRetryAfterMs = (error: unknown): number | undefined =>
  isKoiError(error) ? error.retryAfterMs : undefined;

const defaultIsRetryable = (error: unknown): boolean => isKoiError(error) && isKoiRetryable(error);

export function createRateLimiter(config?: RateLimiterConfig): RateLimiter {
  const retryConfig = config?.retry ?? DEFAULT_RETRY_CONFIG;
  const extractRetryAfterMs = config?.extractRetryAfterMs ?? defaultExtractRetryAfterMs;
  const isRetryable = config?.isRetryable ?? defaultIsRetryable;

  // let justified: mutable queue state, immutable swap on each mutation
  let queue: readonly QueueEntry[] = [];
  // let justified: re-entrancy guard for the drain loop
  let processing = false;

  // Wrap classifier hooks so a thrown user callback never wedges the queue —
  // we treat a thrown classifier as "not retryable" and reject the entry below.
  const safeExtract = (error: unknown): number | undefined => {
    try {
      return extractRetryAfterMs(error);
    } catch {
      return undefined;
    }
  };
  const safeIsRetryable = (error: unknown): boolean => {
    try {
      return isRetryable(error);
    } catch {
      return false;
    }
  };

  const drain = async (): Promise<void> => {
    if (processing) return;
    processing = true;
    try {
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

            const retryAfterMs = safeExtract(error);
            const retryable = retryAfterMs !== undefined || safeIsRetryable(error);

            // Stop on permanent failures or when the budget is spent — the queue
            // must not sleep on the terminal attempt and must never re-issue a
            // send for an error not classified as retryable.
            if (!retryable || attempt >= retryConfig.maxRetries) break;

            // computeBackoff is pure but takes an injectable RNG; if a caller
            // passes a config that throws, treat as terminal failure rather than
            // wedging the queue.
            // let justified: mutable to preserve final delay across try/catch
            let delay: number;
            try {
              delay = retryAfterMs ?? computeBackoff(attempt, retryConfig);
            } catch {
              break;
            }
            await sleep(delay);
          }
        }

        if (lastError !== undefined) {
          entry.reject(lastError);
        } else {
          entry.resolve();
        }
      }
    } finally {
      processing = false;
    }
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
