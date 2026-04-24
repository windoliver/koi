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
 * Processing reservations expire after `processingTtlMs` (default: 30 s) so that
 * hung or cancelled requests cannot permanently black-hole a delivery key.
 * Committed entries expire after `ttlMs` (default: 24 h). Bounded by `maxSize`
 * (default: 10 000) to cap memory; oldest committed entries evicted first.
 */

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PROCESSING_TTL_MS = 30_000;
const DEFAULT_MAX_SIZE = 10_000;

type EntryState = "processing" | "committed";

interface IdempotencyEntry {
  readonly state: EntryState;
  readonly expiresAt: number;
}

export interface IdempotencyStoreOptions {
  readonly ttlMs?: number | undefined;
  /** TTL for in-flight (processing) reservations. Expired processing entries are
   *  pruned so hung/cancelled requests cannot permanently black-hole a delivery key. */
  readonly processingTtlMs?: number | undefined;
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
  const processingTtlMs = options.processingTtlMs ?? DEFAULT_PROCESSING_TTL_MS;
  const maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;

  const store = new Map<string, IdempotencyEntry>();

  function prune(): void {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (entry.expiresAt <= now) {
        // Remove expired entries regardless of state: expired processing entries
        // from hung/cancelled requests must not permanently burn a delivery key.
        store.delete(key);
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
      // Expired entry — allow retry
      store.delete(key);
    }
    // Reserve with a processing TTL so hung requests cannot permanently tombstone a key.
    store.set(key, { state: "processing", expiresAt: Date.now() + processingTtlMs });
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
