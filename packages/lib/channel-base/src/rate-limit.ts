/**
 * Rate-limit-aware send queue for channel adapters.
 *
 * Sequential FIFO queue. Pauses on rate-limit errors and retries with
 * exponential backoff. The default policy is intentionally narrower than
 * `@koi/errors.isRetryable()`: it auto-retries only the transport-class
 * codes RATE_LIMIT and TIMEOUT, because state-gated codes such
 * as AUTH_REQUIRED and RESOURCE_EXHAUSTED are recoverable only after
 * external intervention and must not be re-issued in a tight loop.
 *
 * Callers with domain knowledge can broaden retry semantics through the
 * `extractRetryAfterMs` and `isRetryable` config hooks; either hook
 * returning a defined retry signal opts the error into retry. Non-KoiError
 * exceptions reject immediately by default so non-idempotent sends are
 * never re-issued.
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
   * Extracts a retry-after delay (in ms) from a caught error. Returning a
   * defined value both schedules the next attempt's delay AND classifies
   * the error as retryable — caller-supplied extractors are trusted because
   * they encode adapter-specific knowledge.
   *
   * The built-in default returns `error.retryAfterMs` only when the error
   * is a `KoiError` whose code is in the transport-retry allowlist
   * (RATE_LIMIT, TIMEOUT). State-gated codes like AUTH_REQUIRED
   * intentionally produce undefined even if they carry `retryAfterMs`, so
   * the queue does not auto-retry them.
   */
  readonly extractRetryAfterMs?: (error: unknown) => number | undefined;
  /**
   * Decides whether an error should be retried independent of any retry-after
   * hint. Defaults to a narrow transport allowlist: `KoiError` with code in
   * { RATE_LIMIT, TIMEOUT }. Pass a custom predicate (e.g.
   * `(e) => isKoiError(e) && isKoiRetryable(e)`) to broaden the policy.
   */
  readonly isRetryable?: (error: unknown) => boolean;
  /**
   * Called when the retry machinery itself fails — a thrown classifier,
   * malformed `computeBackoff` config, or rejected `sleep`. The default
   * `swallow` behavior preserves queue progress, but operators that want
   * a diagnostic breadcrumb can supply this hook to surface the broken
   * retry path. Hook errors are themselves swallowed.
   */
  readonly onInternalError?: (
    stage: "extract" | "classify" | "backoff" | "sleep",
    error: unknown,
  ) => void;
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
 * stands a real chance of succeeding without external intervention AND
 * where re-issuing the operation cannot produce a duplicate user-visible
 * side effect.
 *
 * Deliberately excluded:
 *   - CONFLICT           → typically a CAS / already-exists mismatch; replaying
 *                          a partially-successful send could duplicate output.
 *                          Adapters with replay-safe conflict semantics opt in
 *                          via a custom `isRetryable`.
 *   - AUTH_REQUIRED      → recoverable only after the user completes OAuth.
 *   - RESOURCE_EXHAUSTED → recoverable only after capacity is freed; tight retry would just thrash.
 *   - PERMISSION / VALIDATION / NOT_FOUND / STALE_REF / INTERNAL / UNAVAILABLE / HEARTBEAT_TIMEOUT
 *                        → either permanent or require operator action.
 *   - EXTERNAL           → defaults to retryable=false in RETRYABLE_DEFAULTS; opt-in via callback.
 */
const TRANSPORT_RETRY_CODES: ReadonlySet<KoiErrorCode> = new Set<KoiErrorCode>([
  "RATE_LIMIT",
  "TIMEOUT",
]);

/** Returns the retry-after hint only when it is a finite, non-negative number. */
const sanitizeRetryAfterMs = (raw: unknown): number | undefined => {
  if (typeof raw !== "number") return undefined;
  if (!Number.isFinite(raw) || raw < 0) return undefined;
  return raw;
};

const defaultExtractRetryAfterMs = (error: unknown): number | undefined => {
  if (!isKoiError(error)) return undefined;
  if (!TRANSPORT_RETRY_CODES.has(error.code)) return undefined;
  return sanitizeRetryAfterMs(error.retryAfterMs);
};

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

  const reportInternal = (
    stage: "extract" | "classify" | "backoff" | "sleep",
    error: unknown,
  ): void => {
    if (config?.onInternalError === undefined) return;
    try {
      config.onInternalError(stage, error);
    } catch {
      // Hook itself misbehaved — swallow so the queue keeps draining.
    }
  };

  // Wrap classifier hooks so a thrown user callback never wedges the queue —
  // we treat a thrown classifier as "not retryable" and reject the entry below.
  const safeExtract = (error: unknown): number | undefined => {
    try {
      return extractRetryAfterMs(error);
    } catch (hookError) {
      reportInternal("extract", hookError);
      return undefined;
    }
  };
  const safeIsRetryable = (error: unknown): boolean => {
    try {
      return isRetryable(error);
    } catch (hookError) {
      reportInternal("classify", hookError);
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

            // A defined retry-after hint OR a positive isRetryable verdict
            // opts the error into a retry. The default extractor already
            // refuses to emit a hint for state-gated codes, so this OR is
            // safe; callers who provide a custom extractor are trusted to
            // know what their hint means.
            const retryAfterMs = sanitizeRetryAfterMs(safeExtract(error));
            const retryable = retryAfterMs !== undefined || safeIsRetryable(error);
            if (!retryable || attempt >= retryConfig.maxRetries) break;

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
            } catch (backoffError) {
              reportInternal("backoff", backoffError);
              break;
            }
            prevDelayMs = delay;
            // Wrap sleep so a sleeper rejection (clock corruption, monkey-
            // patched timers, etc.) does not abandon the in-flight entry —
            // we treat it as terminal failure for this entry and resume
            // draining instead of leaving the caller hanging forever.
            try {
              await sleep(delay);
            } catch (sleepError) {
              reportInternal("sleep", sleepError);
              break;
            }
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
