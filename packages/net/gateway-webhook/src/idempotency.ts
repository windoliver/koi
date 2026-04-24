/**
 * In-memory idempotency store — deduplicates webhook deliveries by key.
 *
 * Entries expire after `ttlMs` (default: 24 hours). Bounded by `maxSize`
 * (default: 10 000) to cap memory use; oldest entries evicted first.
 *
 * Two-phase API: `isDuplicate()` checks without committing, `record()` commits.
 * Always call `record()` only after the request is fully accepted (auth +
 * dispatch succeeded). Calling them in this order prevents transient failures
 * from burning the dedup key and silently dropping provider retries.
 */

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_SIZE = 10_000;

interface IdempotencyEntry {
  readonly expiresAt: number;
}

export interface IdempotencyStoreOptions {
  readonly ttlMs?: number | undefined;
  readonly maxSize?: number | undefined;
}

export interface IdempotencyStore {
  /** Returns true if the key has already been recorded (is a duplicate). Does NOT commit. */
  readonly isDuplicate: (key: string) => boolean;
  /** Commit a key as seen. Call only after full successful acceptance. */
  readonly record: (key: string) => void;
  /** Prune expired entries. Called automatically; exposed for testing. */
  readonly prune: () => void;
}

export function createIdempotencyStore(options: IdempotencyStoreOptions = {}): IdempotencyStore {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;

  // Insertion-ordered map: oldest keys at the front.
  const store = new Map<string, IdempotencyEntry>();

  function prune(): void {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (entry.expiresAt <= now) {
        store.delete(key);
      } else {
        break; // Map is insertion-ordered; older entries come first
      }
    }
  }

  function isDuplicate(key: string): boolean {
    prune();
    const existing = store.get(key);
    return existing !== undefined && existing.expiresAt > Date.now();
  }

  function record(key: string): void {
    // Evict oldest entry if at capacity
    if (store.size >= maxSize) {
      const oldest = store.keys().next().value;
      if (oldest !== undefined) store.delete(oldest);
    }
    store.set(key, { expiresAt: Date.now() + ttlMs });
  }

  return { isDuplicate, record, prune };
}
