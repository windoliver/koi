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
import { createDeleteArtifact } from "./delete.js";
import { createGetArtifact } from "./get.js";
import { createListArtifacts } from "./list.js";
import { acquireLock } from "./lock.js";
import { createSaveArtifact } from "./save.js";
import { createRevokeShare, createShareArtifact } from "./share.js";
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

    const saveArtifact = createSaveArtifact({ db, blobStore, config });
    const getArtifact = createGetArtifact({ db, blobStore });
    const listArtifacts = createListArtifacts({ db });
    const deleteArtifact = createDeleteArtifact({ db });
    const shareArtifact = createShareArtifact({ db });
    const revokeShare = createRevokeShare({ db });

    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      db?.close();
      releaseLock();
    };

    return {
      saveArtifact,
      getArtifact,
      listArtifacts,
      deleteArtifact,
      shareArtifact,
      revokeShare,
      close,
    };
  } catch (err) {
    db?.close();
    releaseLock();
    throw err;
  }
}
