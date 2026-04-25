/**
 * In-memory idempotency store — deduplicates webhook deliveries by key.
 *
 * Four-method API prevents concurrent double-dispatch and key burn on failure:
 *   1. `tryBegin(key)` — atomically reserves the key; returns a reservation token
 *      on success, or a rejection reason. Runs synchronously so the JS event loop
 *      prevents interleaving between check and reservation.
 *   2. `renew(key, token)` — extends the processing TTL while the request is still
 *      active. Call periodically during long dispatches to prevent expiry-driven
 *      concurrent reprocessing of the same delivery.
 *   3. `commit(key, token)` — permanently marks the key as seen after successful
 *      acceptance. Token guards against stale commits: if the processing TTL expired
 *      and a newer reservation won, the stale commit is a no-op.
 *   4. `abort(key, token)` — releases the reservation after a transient failure so
 *      provider retries are accepted. Token guards prevent stale aborts from
 *      releasing a newer reservation.
 *
 * Processing reservations expire after `processingTtlMs` (default: 5 min). The
 * webhook server automatically renews the lease every `processingTtlMs / 2` while
 * dispatch is in progress, so slow-but-healthy dispatches stay protected. Hung or
 * dead requests stop renewing and their entries eventually expire.
 *
 * At capacity (`maxSize`, default: 10 000), `tryBegin` returns `"capacity-exceeded"`
 * (503) — committed entries are NOT evicted to make room because eviction silently
 * drops replay protection and can cause duplicate side effects under load.
 *
 * **Scope:** this store is in-process only. Dedup state is lost on restart and
 * not shared across replicas. For cross-process replay protection, implement
 * `IdempotencyStore` against a shared/persistent backend.
 */

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
// 5-minute processing TTL: long enough for most slow dispatchers, short enough
// to recover from truly hung/crashed requests. The webhook server renews every
// processingTtlMs/2 while dispatch is active, so this only triggers for dead requests.
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
  expiresAt: number; // mutable — updated by renew()
}

interface CommittedEntry {
  readonly state: "committed";
  readonly expiresAt: number;
}

type IdempotencyEntry = ProcessingEntry | CommittedEntry;

export interface IdempotencyStoreOptions {
  readonly ttlMs?: number | undefined;
  /** TTL for in-flight (processing) reservations. Expired processing entries are
   *  pruned so truly dead requests cannot permanently black-hole a delivery key.
   *  Active requests renew their lease automatically; tune this to be longer than
   *  your slowest healthy dispatch path. */
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
   *  - `{ state: "ok", token }` — reservation won; pass the token to `renew`/`commit`/`abort`
   *  - `{ state: "duplicate" }` — key is already committed; return 200 duplicate
   *  - `{ state: "in-flight" }` — key is currently processing by another request;
   *    return 503 so the provider keeps retrying. Do NOT return 200 — the original
   *    may still fail.
   *  - `{ state: "capacity-exceeded" }` — store is full; return 503 so the provider
   *    retries after entries expire. Committed entries are NOT evicted.
   *
   * Runs synchronously — the JS event loop guarantees no interleaving between
   * check and reservation, preventing concurrent duplicate dispatch.
   */
  readonly tryBegin: (key: string) => TryBeginResult;
  /**
   * Extend the processing TTL for an active reservation. Call periodically during
   * long dispatches to prevent expiry-driven concurrent reprocessing. Token mismatch
   * is a no-op (stale caller). Returns true if the renewal succeeded.
   */
  readonly renew: (key: string, token: string) => boolean;
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
  /** Prune expired entries. Called automatically by tryBegin; exposed for testing. */
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
        // from dead/cancelled requests must not permanently burn a delivery key.
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
    // Fail closed at capacity: do NOT evict committed entries — eviction silently
    // drops replay protection and can cause duplicate side effects under load.
    if (store.size >= maxSize) return { state: "capacity-exceeded" };
    const token = nextToken();
    store.set(key, { state: "processing", token, expiresAt: Date.now() + processingTtlMs });
    return { state: "ok", token };
  }

  function renew(key: string, token: string): boolean {
    const entry = store.get(key);
    if (entry?.state !== "processing" || entry.token !== token) return false;
    // Extend expiry from now — guards active dispatches against mid-flight expiry.
    entry.expiresAt = Date.now() + processingTtlMs;
    return true;
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

  return { tryBegin, renew, commit, abort, prune };
}
