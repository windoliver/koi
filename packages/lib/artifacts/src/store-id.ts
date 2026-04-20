/**
 * Layer 2 of §3.0: pair the metadata DB with the blob backend via a UUID
 * `store_id`. Prevents two different DBs from sharing the same blob backend
 * (which would let one's sweep delete the other's blobs).
 *
 * The sentinel is backend-agnostic — it routes through `blobStore.sentinel`
 * (see `@koi/blob-cas`). Filesystem backends persist it at
 * `<blobDir>/.store-id`; remote backends (S3, etc.) use a backend-native
 * key (e.g. `<prefix>/__store_id__`). This module enforces UUID shape +
 * pairing invariants uniformly across backends.
 *
 * Layer 1 (advisory lock) is in lock.ts.
 */

import type { Database } from "bun:sqlite";
import type { BlobStore } from "@koi/blob-cas";

const STORE_ID_KEY = "store_id";
// UUID v4 format; reject any other sentinel value as corrupt.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readStoreIdFromDb(db: Database): string | undefined {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(STORE_ID_KEY) as {
    readonly value: string;
  } | null;
  return row?.value;
}

async function readSentinel(blobStore: BlobStore): Promise<string | undefined> {
  if (blobStore.sentinel === undefined) {
    throw new Error(
      "BlobStore is missing its store-id sentinel; every built-in factory populates `sentinel` — third-party backends must do the same",
    );
  }
  const content = await blobStore.sentinel.readStoreId();
  if (content === undefined) return undefined;
  const trimmed = content.trim();
  if (trimmed === "") return undefined;
  // A malformed sentinel (truncated / corrupted write / wrong format) is a
  // corruption signal — reject rather than silently self-heal a garbage ID
  // into the DB.
  if (!UUID_RE.test(trimmed)) {
    throw new Error(
      "Blob backend sentinel contains a malformed store_id; operator must repair or reset explicitly",
    );
  }
  return trimmed;
}

async function writeSentinel(blobStore: BlobStore, id: string): Promise<void> {
  if (blobStore.sentinel === undefined) {
    throw new Error(
      "BlobStore is missing its store-id sentinel; cannot pair metadata DB with an unsentineled backend",
    );
  }
  await blobStore.sentinel.writeStoreId(id);
}

/**
 * Detect the "sentinel already exists" signal surfaced by conditional-create
 * backends (S3's `IfNoneMatch: "*"` branch). The phrase "already exists" is
 * the stable wording used in the S3 backend's thrown Error message — keep
 * both backends aligned on this literal so this check doesn't false-positive
 * on unrelated failures (credentials, transport).
 */
function isSentinelAlreadyExistsError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes("already exists");
}

function writeStoreIdToDb(db: Database, id: string): void {
  db.query("INSERT INTO meta (key, value) VALUES (?, ?)").run(STORE_ID_KEY, id);
}

function dbHasArtifactsOrPending(db: Database): boolean {
  const counts = db
    .query(
      "SELECT (SELECT COUNT(*) FROM artifacts) + (SELECT COUNT(*) FROM pending_blob_deletes) + (SELECT COUNT(*) FROM pending_blob_puts) AS total",
    )
    .get() as { readonly total: number };
  return counts.total > 0;
}

async function blobStoreHasAnyBlobs(blobStore: BlobStore): Promise<boolean> {
  for await (const _hash of blobStore.list()) {
    return true;
  }
  return false;
}

export async function ensureStoreIdPair(args: {
  readonly db: Database;
  readonly blobStore: BlobStore;
}): Promise<string> {
  const dbId = readStoreIdFromDb(args.db);
  const sentinelId = await readSentinel(args.blobStore);

  if (dbId !== undefined && sentinelId !== undefined) {
    if (dbId !== sentinelId) {
      throw new Error("Blob backend is paired with a different ArtifactStore; refusing to open");
    }
    return dbId;
  }

  // Asymmetric / missing cases. A one-sided store_id is only safe to self-
  // heal when BOTH sides are provably empty — that matches the crashed-mid-
  // bootstrap shape where the first side was written but the second side
  // didn't land before the process died. If either SQLite OR the blob
  // backend has any content, a missing side is operator-grade repair:
  //   - DB non-empty → metadata exists, sentinel loss is restore territory
  //   - Blob backend non-empty → a previous store owned those bytes, and
  //     self-healing would silently re-pair them to this DB, letting later
  //     sweeps delete them
  const storeIsEmpty =
    !dbHasArtifactsOrPending(args.db) && !(await blobStoreHasAnyBlobs(args.blobStore));

  if (dbId !== undefined && sentinelId === undefined) {
    if (storeIsEmpty) {
      await writeSentinel(args.blobStore, dbId);
      return dbId;
    }
    throw new Error(
      "Blob backend is missing store-id sentinel; operator must restore or reset explicitly",
    );
  }

  if (dbId === undefined && sentinelId !== undefined) {
    if (storeIsEmpty) {
      writeStoreIdToDb(args.db, sentinelId);
      return sentinelId;
    }
    throw new Error("Metadata DB is missing store-id; operator must restore or reset explicitly");
  }

  // Both missing — only safe to bootstrap if the store is provably empty.
  if (!storeIsEmpty) {
    throw new Error(
      "Store-id missing on a non-empty store; operator must restore or reset explicitly",
    );
  }

  // Crash-safe bootstrap: write sentinel first, then DB row. If we crash
  // after sentinel but before DB, next open sees sentinel-present/DB-missing
  // with an empty store and self-heals. If we crash before sentinel, next
  // open sees both-missing and retries bootstrap from scratch.
  //
  // Race window with conditional-create backends (e.g. S3 with
  // `IfNoneMatch: "*"`): two processes both read an absent sentinel and
  // race to write. The backend lets only one win; the loser sees an
  // "already exists" error. Re-read the sentinel and compare — in practice
  // the loser's `crypto.randomUUID()` never matches the winner's, so we
  // surface the standard pairing-mismatch error. Keeping the branches
  // symmetric means a test can still hit the match path if it seeds an
  // identical UUID, but production will always mismatch.
  const fresh = crypto.randomUUID();
  try {
    await writeSentinel(args.blobStore, fresh);
  } catch (err) {
    if (!isSentinelAlreadyExistsError(err)) throw err;
    const raced = await readSentinel(args.blobStore);
    if (raced === undefined) throw err;
    if (raced !== fresh) {
      throw new Error("Blob backend is paired with a different ArtifactStore; refusing to open");
    }
    writeStoreIdToDb(args.db, raced);
    return raced;
  }
  writeStoreIdToDb(args.db, fresh);
  return fresh;
}
