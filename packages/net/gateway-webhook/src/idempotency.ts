/**
 * In-memory idempotency store — deduplicates webhook deliveries by key.
 *
 * Entries expire after `ttlMs` (default: 24 hours). Bounded by `maxSize`
 * (default: 10 000) to cap memory use; oldest entries evicted first.
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
  /** Returns true if key is new (not a duplicate). Registers key on first call. */
  readonly check: (key: string) => boolean;
  /** Prune expired entries. Called automatically by check(); exposed for testing. */
  readonly prune: () => void;
}

export function createIdempotencyStore(options: IdempotencyStoreOptions = {}): IdempotencyStore {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;

  // Insertion-ordered map: oldest keys at the front.
  // let allowed per CLAUDE.md since Map is mutated in place (shared mutable state).
  // biome-ignore lint/style/useConst: intentionally mutable
  let store = new Map<string, IdempotencyEntry>();

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

  function check(key: string): boolean {
    prune();

    const existing = store.get(key);
    if (existing !== undefined && existing.expiresAt > Date.now()) {
      return false; // duplicate
    }

    // Evict oldest entry if at capacity
    if (store.size >= maxSize) {
      const oldest = store.keys().next().value;
      if (oldest !== undefined) store.delete(oldest);
    }

    store.set(key, { expiresAt: Date.now() + ttlMs });
    return true; // new
  }

  return { check, prune };
}
