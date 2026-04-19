/**
 * createArtifactStore — factory assembling the layers:
 *   1. Acquire single-writer advisory lock (lock.ts)
 *   2. Open + pragma SQLite (sqlite.ts)
 *   3. Pair DB store-id with blob backend sentinel (store-id.ts)
 *   4. Build the CRUD surface (save/get/list/delete/share/revoke)
 *
 * Plan 2 ships a minimal close() that releases the lock and closes SQLite.
 * Plan 4 replaces it with a full mutation barrier.
 */

import type { Database } from "bun:sqlite";
import { type BlobStore, createFilesystemBlobStore } from "@koi/blob-cas";
import { acquireLock } from "./lock.js";
import { openDatabase } from "./sqlite.js";
import { ensureStoreIdPair } from "./store-id.js";
import type { ArtifactStore, ArtifactStoreConfig } from "./types.js";

export async function createArtifactStore(config: ArtifactStoreConfig): Promise<ArtifactStore> {
  const releaseLock = acquireLock(config.dbPath);

  let db: Database | undefined;
  try {
    db = openDatabase(config);
    const blobStore: BlobStore = config.blobStore ?? createFilesystemBlobStore(config.blobDir);
    await ensureStoreIdPair({ db, blobDir: config.blobDir, blobStore });

    // Task 9–13 will replace these with real implementations. Intentionally
    // throwing so any accidental call during Plan 2 development is loud.
    const notImpl = async (): Promise<never> => {
      throw new Error("not implemented in Plan 2 skeleton");
    };

    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      db?.close();
      releaseLock();
    };

    return {
      saveArtifact: notImpl,
      getArtifact: notImpl,
      listArtifacts: notImpl,
      deleteArtifact: notImpl,
      shareArtifact: notImpl,
      revokeShare: notImpl,
      close,
    };
  } catch (err) {
    db?.close();
    releaseLock();
    throw err;
  }
}
