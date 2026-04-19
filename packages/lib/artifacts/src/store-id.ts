/**
 * Layer 2 of §3.0: pair the metadata DB with the blob backend via a UUID
 * `store_id`. Prevents two different DBs from sharing the same blob backend
 * (which would let one's sweep delete the other's blobs).
 *
 * Layer 1 (advisory lock) is in lock.ts.
 */

import type { Database } from "bun:sqlite";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { BlobStore } from "@koi/blob-cas";

const STORE_ID_KEY = "store_id";
const SENTINEL_FILENAME = ".store-id";

export function readStoreIdFromDb(db: Database): string | undefined {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(STORE_ID_KEY) as {
    readonly value: string;
  } | null;
  return row?.value;
}

function readSentinelFromFs(blobDir: string): string | undefined {
  const path = join(blobDir, SENTINEL_FILENAME);
  if (!existsSync(path)) return undefined;
  const content = readFileSync(path, "utf8").trim();
  return content || undefined;
}

/**
 * Durably write the sentinel file. Uses open+write+fsync+close+fsync-dir
 * so bootstrap/self-heal survives power loss — a crash after the DB row
 * commits but before the sentinel is durable would otherwise leave the
 * store in the operator-repair branch (DB present, sentinel missing,
 * non-empty store).
 */
function writeSentinelToFs(blobDir: string, id: string): void {
  const path = join(blobDir, SENTINEL_FILENAME);
  const data = Buffer.from(id, "utf8");
  const fd = openSync(path, "w");
  try {
    let written = 0;
    while (written < data.byteLength) {
      written += writeSync(fd, data, written, data.byteLength - written);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // fsync the parent directory so the filename itself is durable.
  try {
    const dirFd = openSync(blobDir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    /* Windows doesn't support fsync on directories; tolerate. */
  }
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
  readonly blobDir: string;
  readonly blobStore: BlobStore;
}): Promise<string> {
  const dbId = readStoreIdFromDb(args.db);
  const sentinelId = readSentinelFromFs(args.blobDir);

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
      writeSentinelToFs(args.blobDir, dbId);
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
  const fresh = crypto.randomUUID();
  writeSentinelToFs(args.blobDir, fresh);
  writeStoreIdToDb(args.db, fresh);
  return fresh;
}
