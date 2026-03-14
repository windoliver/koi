/**
 * Typed side-channel for middleware → engine adapter communication.
 *
 * Middleware attaches data to a request object; engine adapters read it.
 * Uses WeakMap so entries are GC'd when the request object is collected.
 *
 * @example
 * // In middleware (L2):
 * const CACHE_HINTS = createSideChannel<CacheHints>("prompt-cache");
 * CACHE_HINTS.set(request, { lastStableIndex: 5, provider: "anthropic" });
 *
 * // In engine adapter (L2):
 * const hints = CACHE_HINTS.get(request);
 */

/**
 * A typed, named side-channel backed by WeakMap.
 * Entries are automatically garbage-collected when the key is no longer referenced.
 */
export interface SideChannel<T> {
  /** Name of this side-channel (for debugging). */
  readonly name: string;
  /** Attach a value to a request-like object. */
  readonly set: (key: object, value: T) => void;
  /** Read the attached value, or undefined if none. */
  readonly get: (key: object) => T | undefined;
  /** Check whether a value is attached. */
  readonly has: (key: object) => boolean;
  /** Remove the attached value. Returns true if an entry was present. */
  readonly delete: (key: object) => boolean;
}

/**
 * Create a named side-channel for passing typed data alongside request objects.
 *
 * @param name - Descriptive name for debugging (e.g., "prompt-cache", "circuit-breaker-state")
 */
export function createSideChannel<T>(name: string): SideChannel<T> {
  const store = new WeakMap<object, T>();

  return {
    name,
    set(key: object, value: T): void {
      store.set(key, value);
    },
    get(key: object): T | undefined {
      return store.get(key);
    },
    has(key: object): boolean {
      return store.has(key);
    },
    delete(key: object): boolean {
      return store.delete(key);
    },
  };
}
