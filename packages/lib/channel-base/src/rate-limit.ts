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

import type { KoiErrorCode } from "@koi/core";
import {
  computeBackoff,
  DEFAULT_RETRY_CONFIG,
  isKoiError,
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

/**
 * Codes that are safe to auto-retry inline within a single send queue.
 * These are transport-level transient conditions where the next attempt
 * stands a real chance of succeeding without external intervention.
 *
 * Deliberately excluded:
 *   - AUTH_REQUIRED      → recoverable only after the user completes OAuth.
 *   - RESOURCE_EXHAUSTED → recoverable only after capacity is freed; tight retry would just thrash.
 *   - PERMISSION / VALIDATION / NOT_FOUND / STALE_REF / INTERNAL / UNAVAILABLE / HEARTBEAT_TIMEOUT
 *                        → either permanent or require operator action.
 *   - EXTERNAL           → defaults to retryable=false in RETRYABLE_DEFAULTS; opt-in via callback.
 */
const TRANSPORT_RETRY_CODES: ReadonlySet<KoiErrorCode> = new Set<KoiErrorCode>([
  "RATE_LIMIT",
  "TIMEOUT",
  "CONFLICT",
]);

/** Returns the retry-after hint only when it is a finite, non-negative number. */
const sanitizeRetryAfterMs = (raw: unknown): number | undefined => {
  if (typeof raw !== "number") return undefined;
  if (!Number.isFinite(raw) || raw < 0) return undefined;
  return raw;
};

const defaultExtractRetryAfterMs = (error: unknown): number | undefined =>
  isKoiError(error) ? sanitizeRetryAfterMs(error.retryAfterMs) : undefined;

const defaultIsRetryable = (error: unknown): boolean =>
  isKoiError(error) && TRANSPORT_RETRY_CODES.has(error.code);

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
        // let justified: feeds decorrelated jitter so the window widens
        let prevDelayMs: number | undefined;
        for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
          try {
            await entry.fn();
            lastError = undefined;
            break;
          } catch (error: unknown) {
            lastError = error;

            // Retry decision must always come from the classifier — a stray
            // retryAfterMs on a non-transport code (e.g. AUTH_REQUIRED) must
            // not be enough to re-issue a non-idempotent send.
            if (!safeIsRetryable(error) || attempt >= retryConfig.maxRetries) break;

            const retryAfterMs = sanitizeRetryAfterMs(safeExtract(error));

            // Route through computeBackoff so the provider hint is clamped to
            // maxBackoffMs and falls back to backoff when the hint is absent.
            // Pass prevDelay so decorrelated jitter widens correctly across
            // retries instead of collapsing to the base delay each time.
            // computeBackoff is pure but its config can technically throw if a
            // caller plugs in a malformed RNG — treat that as terminal failure
            // rather than wedging the queue.
            // let justified: mutable to preserve final delay across try/catch
            let delay: number;
            try {
              delay = computeBackoff(attempt, retryConfig, retryAfterMs, undefined, prevDelayMs);
            } catch {
              break;
            }
            prevDelayMs = delay;
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
