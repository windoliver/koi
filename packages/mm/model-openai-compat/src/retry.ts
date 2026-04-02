/**
 * Retry logic with exponential backoff + jitter.
 *
 * Based on Claude Code's production retry strategy:
 * - 500ms * 2^attempt, capped at 32s
 * - ±25% jitter to prevent thundering herd
 * - Respects Retry-After headers
 * - 529 (overloaded) only retried for foreground requests
 */

/** Default retry configuration. */
export interface RetryConfig {
  /** Maximum number of retry attempts. Default: 3. */
  readonly maxRetries: number;
  /** Base delay in ms. Default: 500. */
  readonly baseDelayMs: number;
  /** Maximum delay in ms. Default: 32000. */
  readonly maxDelayMs: number;
  /** Jitter factor (0-1). Default: 0.25. */
  readonly jitterFactor: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 32_000,
  jitterFactor: 0.25,
};

/**
 * HTTP status codes that are retryable.
 * - 408: Request Timeout
 * - 429: Rate Limited
 * - 500+: Server errors
 * - 529: Overloaded (Anthropic/OpenRouter specific)
 */
export function isRetryableStatus(status: number): boolean {
  if (status === 408 || status === 429 || status === 529) return true;
  if (status >= 500) return true;
  return false;
}

/**
 * Check if a message or error indicates a connection reset (ECONNRESET/EPIPE).
 * These indicate dead pooled connections that need fresh TCP.
 */
export function isConnectionResetMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("econnreset") || lower.includes("epipe") || lower.includes("socket hang up")
  );
}

/**
 * Check if a thrown error is a connection reset.
 */
export function isConnectionResetError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return isConnectionResetMessage(error.message);
}

/**
 * Compute delay for a retry attempt with jitter.
 * Respects provider Retry-After hint if present.
 */
export function computeRetryDelay(
  attempt: number,
  config: RetryConfig,
  retryAfterMs?: number,
): number {
  // Provider hint takes precedence
  if (retryAfterMs !== undefined && retryAfterMs > 0) {
    return Math.min(retryAfterMs, config.maxDelayMs);
  }
  // Exponential backoff: baseDelay * 2^attempt
  const exponential = config.baseDelayMs * 2 ** attempt;
  const capped = Math.min(exponential, config.maxDelayMs);
  // ±jitter to prevent thundering herd
  const jitter = capped * config.jitterFactor * (2 * Math.random() - 1);
  return Math.max(0, Math.round(capped + jitter));
}

/**
 * Sleep for the given duration, respecting an abort signal.
 * Returns false if aborted during sleep.
 */
export function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(true), ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve(false);
      },
      { once: true },
    );
  });
}
