/**
 * SecureStorage interface — platform-agnostic credential store.
 *
 * Implementations must be safe for concurrent access from multiple
 * processes. Use `withLock()` for multi-step read-modify-write sequences.
 */

export interface SecureStorage {
  /** Retrieve a stored value by key. Returns undefined if not found. */
  readonly get: (key: string) => Promise<string | undefined>;
  /** Store a value under key. Overwrites existing values. */
  readonly set: (key: string, value: string) => Promise<void>;
  /** Delete a stored value. Returns true if a value was deleted. */
  readonly delete: (key: string) => Promise<boolean>;
  /** Acquire exclusive lock for multi-step read-modify-write operations. */
  readonly withLock: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
}
