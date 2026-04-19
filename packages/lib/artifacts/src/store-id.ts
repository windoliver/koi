/**
 * Layer 2 of §3.0: pair the metadata DB with the blob backend via a UUID
 * `store_id`. Prevents two different DBs from sharing the same blob backend
 * (which would let one's sweep delete the other's blobs).
 *
 * Layer 1 (advisory lock) is in lock.ts.
 */

import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

function writeSentinelToFs(blobDir: string, id: string): void {
  writeFileSync(join(blobDir, SENTINEL_FILENAME), id, "utf8");
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

  if (dbId !== undefined && sentinelId === undefined) {
    throw new Error(
      "Blob backend is missing store-id sentinel; operator must restore or reset explicitly",
    );
  }

  if (dbId === undefined && sentinelId !== undefined) {
    throw new Error("Metadata DB is missing store-id; operator must restore or reset explicitly");
  }

  // Both missing — only safe to bootstrap if the store is provably empty.
  if (dbHasArtifactsOrPending(args.db)) {
    throw new Error(
      "Store-id missing on a non-empty store; operator must restore or reset explicitly",
    );
  }

  const fresh = crypto.randomUUID();
  writeStoreIdToDb(args.db, fresh);
  writeSentinelToFs(args.blobDir, fresh);
  return fresh;
}
