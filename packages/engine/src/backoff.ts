/**
 * Decorrelated jitter backoff — AWS-validated best practice.
 *
 * Formula: floor(random_between(baseMs, min(capMs, prevSleepMs * 3)))
 * This avoids thundering herds while providing exponential-like growth.
 */

// ---------------------------------------------------------------------------
// Backoff computation
// ---------------------------------------------------------------------------

/**
 * Compute the next backoff delay using decorrelated jitter.
 *
 * @param prevSleepMs - Previous sleep duration (0 for first attempt)
 * @param baseMs - Minimum backoff (default: 100ms)
 * @param capMs - Maximum backoff cap (default: 30_000ms)
 * @returns Next sleep duration in milliseconds, always in [baseMs, capMs]
 */
export function computeBackoff(prevSleepMs: number, baseMs = 100, capMs = 30_000): number {
  const upper = Math.min(capMs, Math.max(baseMs, prevSleepMs * 3));
  return Math.floor(baseMs + Math.random() * (upper - baseMs));
}
