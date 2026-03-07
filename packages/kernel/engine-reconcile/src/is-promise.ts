/**
 * Type guard for detecting Promise values at runtime.
 *
 * Used by reconcilers and the runner to handle sync vs async code paths.
 * Checks for a "thenable" object (duck-typing), which covers both native
 * Promises and Promise-like objects.
 */
export function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return value !== null && typeof value === "object" && "then" in value;
}
