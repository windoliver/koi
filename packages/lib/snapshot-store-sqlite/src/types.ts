/**
 * Configuration types for the SQLite snapshot store.
 */

/**
 * Configuration for `createSnapshotStoreSqlite`.
 *
 * The store is generic over the payload type `T`. If `blobDir` and
 * `extractBlobRefs` are both provided, the store will sweep orphan blobs
 * during `prune()` (mark-and-sweep GC). Otherwise blob GC is skipped.
 */
export interface SqliteSnapshotStoreConfig<T> {
  /**
   * Path to the SQLite database file. Use `":memory:"` for in-memory tests.
   */
  readonly path: string;

  /**
   * Optional content-addressed blob directory. If set, prune sweeps it for
   * orphan blobs not referenced by any live snapshot.
   *
   * The store does NOT read or write blob *contents* — that is the consumer's
   * responsibility (e.g., `@koi/checkpoint` writes blobs to CAS). The store
   * only owns the directory listing during GC.
   */
  readonly blobDir?: string;

  /**
   * Function used by GC to extract blob hashes from a payload. Required if
   * `blobDir` is set; ignored otherwise.
   */
  readonly extractBlobRefs?: (data: T) => readonly string[];

  /**
   * Durability level.
   * - `"process"` (default): `synchronous=NORMAL`. Survives app crashes.
   * - `"os"`: `synchronous=FULL`. Survives OS crashes and power loss.
   *
   * Both modes use WAL journal mode.
   */
  readonly durability?: "process" | "os";
}
