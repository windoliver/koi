/**
 * In-memory idempotency store — deduplicates webhook deliveries by key.
 *
 * Three-phase API prevents both concurrent double-dispatch and key burn on failure:
 *   1. `tryBegin(key)` — atomically reserves the key; returns a reservation token
 *      on success, or a rejection reason. Runs synchronously so the JS event loop
 *      prevents interleaving between check and reservation.
 *   2. `commit(key, token)` — permanently marks the key as seen after successful
 *      acceptance. Token guards against stale commits: if the processing TTL expired
 *      and a newer reservation won, the stale commit is a no-op.
 *   3. `abort(key, token)` — releases the reservation after a transient failure so
 *      provider retries are accepted. Token guards prevent stale aborts from
 *      releasing a newer reservation.
 *
 * Processing reservations expire after `processingTtlMs` (default: 5 min) so that
 * hung or cancelled requests cannot permanently black-hole a delivery key. If a
 * request outlives its TTL and a retry takes over, the stale request's `commit` or
 * `abort` call will be a token-mismatch no-op — the newer reservation is unaffected.
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

// Monotonic counter — simpler and cheaper than crypto.randomUUID() for tokens.
// Unique within a process lifetime, which is all we need for in-memory stores.
let tokenCounter = 0;
function nextToken(): string {
  return (tokenCounter++).toString(36);
}

interface ProcessingEntry {
  readonly state: "processing";
  readonly token: string;
  readonly expiresAt: number;
}

interface CommittedEntry {
  readonly state: "committed";
  readonly expiresAt: number;
}

type IdempotencyEntry = ProcessingEntry | CommittedEntry;

export interface IdempotencyStoreOptions {
  readonly ttlMs?: number | undefined;
  /** TTL for in-flight (processing) reservations. Expired processing entries are
   *  pruned so hung/cancelled requests cannot permanently black-hole a delivery key. */
  readonly processingTtlMs?: number | undefined;
  readonly maxSize?: number | undefined;
}

export type TryBeginResult =
  | { readonly state: "ok"; readonly token: string }
  | { readonly state: "duplicate" | "in-flight" | "capacity-exceeded" };

export interface IdempotencyStore {
  /**
   * Atomically check and reserve a key.
   *
   * Returns:
   *  - `{ state: "ok", token }` — reservation won; pass the token to `commit`/`abort`
   *  - `{ state: "duplicate" }` — key is already committed; return 200 duplicate
   *  - `{ state: "in-flight" }` — key is currently processing by another request;
   *    return 503 so the provider keeps retrying. Do NOT return 200 — the original
   *    may still fail.
   *  - `{ state: "capacity-exceeded" }` — store is full of in-flight entries;
   *    return 503 so the provider retries after processing entries drain.
   *
   * Runs synchronously — the JS event loop guarantees no interleaving between
   * check and reservation, preventing concurrent duplicate dispatch.
   */
  readonly tryBegin: (key: string) => TryBeginResult;
  /**
   * Permanently mark the key as seen. Requires the token from `tryBegin`.
   * Token mismatch (stale commit after TTL expiry + newer reservation) is a no-op.
   */
  readonly commit: (key: string, token: string) => void;
  /**
   * Release the reservation without committing. Requires the token from `tryBegin`.
   * Token mismatch (stale abort) is a no-op — prevents releasing a newer reservation.
   */
  readonly abort: (key: string, token: string) => void;
  /** Prune expired entries. Called automatically; exposed for testing. */
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
      if (existing.state === "processing") return { state: "in-flight" };
      if (existing.expiresAt > Date.now()) return { state: "duplicate" };
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
      if (!evicted) return { state: "capacity-exceeded" };
    }
    const token = nextToken();
    // Reserve with a processing TTL so hung requests cannot permanently tombstone a key.
    store.set(key, { state: "processing", token, expiresAt: Date.now() + processingTtlMs });
    return { state: "ok", token };
  }

  function commit(key: string, token: string): void {
    const entry = store.get(key);
    // Guard: only commit our own reservation. If the TTL expired and a newer
    // reservation took over, the stale commit must not overwrite it.
    if (entry?.state !== "processing" || entry.token !== token) return;
    // commit() replaces the existing processing slot — store.size does not change.
    store.set(key, { state: "committed", expiresAt: Date.now() + ttlMs });
  }

  function abort(key: string, token: string): void {
    const entry = store.get(key);
    // Only release our own processing reservation. Stale aborts (token mismatch)
    // or aborts on committed entries must not reopen the dedup window.
    if (entry?.state === "processing" && entry.token === token) {
      store.delete(key);
    }
  }

  return { tryBegin, commit, abort, prune };
}
