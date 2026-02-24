/**
 * Retry with exponential backoff and jitter.
 *
 * Handles transient failures (rate limits, timeouts, server errors)
 * by retrying with increasing delays.
 */

import type { KoiError, KoiErrorCode } from "@koi/core";
import { toKoiError } from "./error-utils.js";

export interface RetryConfig {
  readonly maxRetries: number;
  readonly backoffMultiplier: number;
  readonly initialDelayMs: number;
  readonly maxBackoffMs: number;
  readonly jitter: boolean;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  backoffMultiplier: 2,
  initialDelayMs: 1_000,
  maxBackoffMs: 30_000,
  jitter: true,
} as const;

/** Error codes that should trigger a retry. */
const RETRYABLE_CODES: ReadonlySet<KoiErrorCode> = new Set([
  "CONFLICT",
  "RATE_LIMIT",
  "TIMEOUT",
  "EXTERNAL",
]);

/** Error codes that should never be retried. */
const NON_RETRYABLE_CODES: ReadonlySet<KoiErrorCode> = new Set([
  "VALIDATION",
  "NOT_FOUND",
  "PERMISSION",
  "INTERNAL",
]);

/**
 * Determines whether an error should be retried based on its code.
 */
export function isRetryable(error: KoiError): boolean {
  if (error.retryable) return true;
  if (NON_RETRYABLE_CODES.has(error.code)) return false;
  return RETRYABLE_CODES.has(error.code);
}

/**
 * Calculates the backoff delay for a given retry attempt.
 *
 * @param attempt - Zero-based attempt index (0 = first retry)
 * @param config - Retry configuration
 * @param retryAfterMs - Optional provider-specified retry delay (overrides calculation)
 * @param random - Injectable random function for deterministic jitter testing
 */
export function calculateBackoff(
  attempt: number,
  config: RetryConfig,
  retryAfterMs?: number,
  random: () => number = Math.random,
): number {
  if (retryAfterMs !== undefined && retryAfterMs > 0) {
    return Math.min(retryAfterMs, config.maxBackoffMs);
  }

  const exponentialDelay = config.initialDelayMs * config.backoffMultiplier ** attempt;
  const clampedDelay = Math.min(exponentialDelay, config.maxBackoffMs);

  if (!config.jitter) {
    return clampedDelay;
  }

  // Full jitter: uniform random between 0 and clampedDelay
  return Math.floor(random() * clampedDelay);
}

/**
 * Executes `fn` with retry logic. On failure, retries up to `config.maxRetries` times
 * with exponential backoff.
 *
 * @param fn - The async function to execute
 * @param config - Retry configuration
 * @param clock - Injectable clock for deterministic delay testing
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  clock: () => number = Date.now,
): Promise<T> {
  let lastError: KoiError | undefined;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      const koiError = toKoiError(error);
      lastError = koiError;

      if (attempt >= config.maxRetries || !isRetryable(koiError)) {
        throw koiError;
      }

      const delay = calculateBackoff(attempt, config, koiError.retryAfterMs);
      await sleep(delay, clock);
    }
  }

  // Should not reach here, but satisfy TypeScript
  throw lastError;
}

function sleep(ms: number, _clock: () => number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
