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
 * Processing reservations expire after `processingTtlMs` (default: 5 min) so that
 * hung or cancelled requests cannot permanently black-hole a delivery key. Tune
 * `processingTtlMs` to be longer than your slowest expected dispatch path.
 * Committed entries expire after `ttlMs` (default: 24 h). Total store size is
 * bounded by `maxSize` (default: 10 000). At capacity, `tryBegin` evicts the
 * oldest committed entry to make room for new reservations (LRU-ish). If all
 * entries are in-flight (no committed to evict), it returns `"capacity-exceeded"`
 * so the caller can return a retryable 503.
 *
 * **Scope:** this store is in-process only. Dedup state is lost on restart and
 * not shared across replicas. For cross-process replay protection, implement
 * `IdempotencyStore` against a shared/persistent backend.
 */

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
// 5-minute processing TTL: long enough for most slow dispatchers, short enough
// to recover from truly hung/crashed requests. Tune down if your dispatcher is
// consistently fast; tune up if dispatch work exceeds 5 minutes.
const DEFAULT_PROCESSING_TTL_MS = 5 * 60 * 1000;
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

export type TryBeginResult = "ok" | "duplicate" | "in-flight" | "capacity-exceeded";

export interface IdempotencyStore {
  /**
   * Atomically check and reserve a key.
   *
   * Returns:
   *  - `"ok"` — reservation won; proceed with auth + dispatch
   *  - `"duplicate"` — key is already committed (seen); return 200 duplicate
   *  - `"in-flight"` — key is currently processing by another request; return
   *    a retryable non-2xx (503) so the provider keeps retrying until one
   *    delivery is committed. Do NOT return 200 here — the original may fail.
   *  - `"capacity-exceeded"` — store is full; return 503 so the provider retries
   *    after expired entries are pruned and capacity is freed.
   *
   * Runs synchronously — the JS event loop guarantees no interleaving between
   * check and reservation, preventing concurrent duplicate dispatch.
   */
  readonly tryBegin: (key: string) => TryBeginResult;
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

  function tryBegin(key: string): TryBeginResult {
    prune();
    const existing = store.get(key);
    if (existing !== undefined) {
      if (existing.state === "processing") return "in-flight";
      if (existing.expiresAt > Date.now()) return "duplicate";
      // Expired committed entry — allow fresh delivery
      store.delete(key);
    }
    // Enforce capacity before inserting. At the cap, evict the oldest committed
    // entry to make room — this gives LRU-ish behavior for normal sustained
    // traffic. If the store is full of processing entries (no committed to evict),
    // return capacity-exceeded so the caller retries after entries drain.
    if (store.size >= maxSize) {
      let evicted = false;
      for (const [k, e] of store) {
        if (e.state === "committed") {
          store.delete(k);
          evicted = true;
          break;
        }
      }
      if (!evicted) return "capacity-exceeded";
    }
    // Reserve with a processing TTL so hung requests cannot permanently tombstone a key.
    store.set(key, { state: "processing", expiresAt: Date.now() + processingTtlMs });
    return "ok";
  }

  function commit(key: string): void {
    // commit() always replaces an existing processing reservation (same slot),
    // so store.size does not change. Capacity was already enforced by tryBegin.
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
