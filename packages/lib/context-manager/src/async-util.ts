/**
 * Async utilities for sync/async estimator compatibility.
 *
 * TokenEstimator returns `T | Promise<T>`. These helpers detect sync
 * results and skip microtask scheduling overhead (P2 optimization).
 */

/**
 * Check if a value is a thenable (Promise-like).
 */
export function isThenable<T>(value: T | Promise<T>): value is Promise<T> {
  return value != null && typeof value === "object" && "then" in value;
}

/**
 * Await a value only if it's a Promise, otherwise return it directly.
 * Eliminates microtask overhead for sync estimators.
 */
export async function maybeAwait<T>(value: T | Promise<T>): Promise<T> {
  return isThenable(value) ? await value : value;
}
