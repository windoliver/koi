/**
 * In-memory idempotency store — deduplicates webhook deliveries by key.
 *
 * Three-phase API prevents both concurrent double-dispatch and key burn on failure:
 *   1. `tryBegin(key)` — atomically reserves the key; returns false if already seen
 *      or currently in-flight (concurrent duplicate). Runs synchronously so the
 *      JS event loop prevents interleaving between check and reservation.
 *   2. `commit(key)` — permanently marks the key as seen after successful acceptance.
 *   3. `abort(key)` — releases the reservation after a transient failure so
 *      provider retries are accepted.
 *
 * Entries expire after `ttlMs` (default: 24 hours). Bounded by `maxSize`
 * (default: 10 000) to cap memory; oldest committed entries evicted first.
 */

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_SIZE = 10_000;

type EntryState = "processing" | "committed";

interface IdempotencyEntry {
  readonly state: EntryState;
  readonly expiresAt: number;
}

export interface IdempotencyStoreOptions {
  readonly ttlMs?: number | undefined;
  readonly maxSize?: number | undefined;
}

export interface IdempotencyStore {
  /**
   * Atomically check and reserve a key. Returns true if this call wins the
   * reservation (proceed with auth + dispatch). Returns false if the key is
   * already committed or currently in-flight.
   *
   * Runs synchronously — the JS event loop guarantees no interleaving between
   * check and reservation, preventing concurrent duplicate dispatch.
   */
  readonly tryBegin: (key: string) => boolean;
  /** Permanently mark the key as seen. Call after fully successful dispatch. */
  readonly commit: (key: string) => void;
  /** Release the reservation without committing. Call after transient failure. */
  readonly abort: (key: string) => void;
  /** Prune expired committed entries. Called automatically; exposed for testing. */
  readonly prune: () => void;
}

export function createIdempotencyStore(options: IdempotencyStoreOptions = {}): IdempotencyStore {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;

  const store = new Map<string, IdempotencyEntry>();

  function prune(): void {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (entry.state === "committed" && entry.expiresAt <= now) {
        store.delete(key);
      } else {
        break;
      }
    }
  }

  function tryBegin(key: string): boolean {
    prune();
    const existing = store.get(key);
    if (existing !== undefined) {
      // Already committed (and not expired) or in-flight → reject
      if (existing.state === "processing") return false;
      if (existing.expiresAt > Date.now()) return false;
      // Expired committed entry — allow retry
      store.delete(key);
    }
    // Reserve as in-progress (no TTL yet — set on commit)
    store.set(key, { state: "processing", expiresAt: Number.POSITIVE_INFINITY });
    return true;
  }

  function commit(key: string): void {
    if (store.size > maxSize) {
      // Evict oldest committed entry to stay within bounds
      for (const [k, e] of store) {
        if (e.state === "committed") {
          store.delete(k);
          break;
        }
      }
    }
    store.set(key, { state: "committed", expiresAt: Date.now() + ttlMs });
  }

  function abort(key: string): void {
    // Only release processing reservations. Committed entries are immutable —
    // abort after commit (e.g. cleanup race) must not reopen the dedup window.
    const entry = store.get(key);
    if (entry?.state === "processing") {
      store.delete(key);
    }
  }

  return { tryBegin, commit, abort, prune };
}
