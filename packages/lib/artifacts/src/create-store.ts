/**
 * createArtifactStore — factory assembling the layers:
 *   1. Acquire single-writer advisory lock (lock.ts)
 *   2. Open + pragma SQLite (sqlite.ts)
 *   3. Pair DB store-id with blob backend sentinel (store-id.ts)
 *   4. Minimal startup recovery for blob_ready=0 rows + stale pending_blob_puts
 *   5. Build the CRUD surface (save/get/list/delete/share/revoke)
 *
 * Plan 2 ships close() with a mutation-barrier: once closing, new public-API
 * calls reject with "ArtifactStore is closing"; close() awaits every
 * in-flight op before closing SQLite + releasing the lock. Plan 4 extends
 * this with a full background repair worker.
 */

import type { Database } from "bun:sqlite";
import { type BlobStore, createFilesystemBlobStore } from "@koi/blob-cas";
import type { ArtifactId, SessionId } from "@koi/core";
import { createDeleteArtifact } from "./delete.js";
import { createGetArtifact } from "./get.js";
import { createListArtifacts } from "./list.js";
import { acquireLock } from "./lock.js";
import { runStartupRecovery } from "./recovery.js";
import { createSaveArtifact } from "./save.js";
import { createRevokeShare, createShareArtifact } from "./share.js";
import { openDatabase } from "./sqlite.js";
import { ensureStoreIdPair } from "./store-id.js";
import type {
  Artifact,
  ArtifactError,
  ArtifactFilter,
  ArtifactStore,
  ArtifactStoreConfig,
  Result,
  SaveArtifactInput,
} from "./types.js";

export async function createArtifactStore(config: ArtifactStoreConfig): Promise<ArtifactStore> {
  if (config.blobStore !== undefined) {
    // The store-id fingerprint pairing (layer 2 of §3.0) is currently only
    // implemented against a local filesystem sentinel in blobDir. Accepting an
    // arbitrary BlobStore would let two differently-pathed stores share the
    // same remote backend without tripping the pairing check — a data-loss
    // foot-gun. Plan 5 adds a sentinel hook to the BlobStore interface and
    // lifts this restriction for S3 + other remote backends.
    throw new Error(
      "ArtifactStoreConfig.blobStore is not supported in Plan 2 — use the default FS backend via blobDir. Plan 5 (#1922) adds pluggable backends with remote-backend sentinel pairing.",
    );
  }
  if (config.policy !== undefined) {
    // LifecyclePolicy (ttlMs / maxSessionBytes / maxVersionsPerName) is
    // advertised on the config but no enforcement exists in Plan 2. Rather
    // than silently ignore it and let callers assume retention/quota limits
    // are active, reject the config explicitly. Plan 3 (#1920) adds full
    // TTL + quota + retention admission + sweepArtifacts.
    throw new Error(
      "ArtifactStoreConfig.policy is not enforced in Plan 2 — TTL, quota, and per-name retention land in Plan 3 (#1920). Do not pass a policy until it ships.",
    );
  }

  const releaseLock = acquireLock(config.dbPath, config.blobDir);

  let db: Database | undefined;
  try {
    db = openDatabase(config);
    const blobStore: BlobStore = createFilesystemBlobStore(config.blobDir);
    await ensureStoreIdPair({ db, blobDir: config.blobDir, blobStore });

    // Startup recovery: resolve blob_ready=0 rows and stale pending_blob_puts
    // rows left by a previous crash. Runs synchronously so the store is in a
    // consistent state before first use.
    await runStartupRecovery({ db, blobStore });

    const rawSave = createSaveArtifact({ db, blobStore, config });
    const rawGet = createGetArtifact({ db, blobStore });
    const rawList = createListArtifacts({ db });
    const rawDelete = createDeleteArtifact({ db });
    const rawShare = createShareArtifact({ db });
    const rawRevoke = createRevokeShare({ db });

    // Mutation barrier: track in-flight ops so close() can drain before
    // closing SQLite + releasing the lock. `closing` short-circuits new calls.
    let closing = false;
    let closed = false;
    let inFlight = 0;
    // Multiple close() callers may be waiting on drain. Collect all resolvers
    // so every awaiter is resumed when inFlight hits zero.
    const drainWaiters: Array<() => void> = [];
    let closePromise: Promise<void> | undefined;

    function checkOpen(): void {
      if (closed) throw new Error("ArtifactStore is closed");
      if (closing) throw new Error("ArtifactStore is closing");
    }

    function track<Args extends readonly unknown[], R>(
      fn: (...args: Args) => Promise<R>,
    ): (...args: Args) => Promise<R> {
      return async (...args: Args): Promise<R> => {
        checkOpen();
        inFlight++;
        try {
          return await fn(...args);
        } finally {
          inFlight--;
          if (inFlight === 0 && drainWaiters.length > 0) {
            const waiters = drainWaiters.splice(0);
            for (const w of waiters) w();
          }
        }
      };
    }

    const saveArtifact: (input: SaveArtifactInput) => Promise<Result<Artifact, ArtifactError>> =
      track(rawSave);
    const getArtifact: (
      id: ArtifactId,
      ctx: { readonly sessionId: SessionId },
    ) => Promise<Result<{ readonly meta: Artifact; readonly data: Uint8Array }, ArtifactError>> =
      track(rawGet);
    const listArtifacts: (
      filter: ArtifactFilter,
      ctx: { readonly sessionId: SessionId },
    ) => Promise<ReadonlyArray<Artifact>> = track(rawList);
    const deleteArtifact: (
      id: ArtifactId,
      ctx: { readonly sessionId: SessionId },
    ) => Promise<Result<void, ArtifactError>> = track(rawDelete);
    const shareArtifact: (
      id: ArtifactId,
      withSessionId: SessionId,
      ctx: { readonly ownerSessionId: SessionId },
    ) => Promise<Result<void, ArtifactError>> = track(rawShare);
    const revokeShare: (
      id: ArtifactId,
      fromSessionId: SessionId,
      ctx: { readonly ownerSessionId: SessionId },
    ) => Promise<Result<void, ArtifactError>> = track(rawRevoke);

    const close = async (): Promise<void> => {
      if (closed) return;
      // Memoize the first close's work so concurrent callers share it.
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        // Wait for in-flight ops to drain. No timeout — a stuck blob I/O must
        // finish before ownership is released; otherwise a new owner could race
        // the old owner's pending writes.
        if (inFlight > 0) {
          await new Promise<void>((resolve) => {
            drainWaiters.push(resolve);
          });
        }
        db?.close();
        releaseLock();
        closed = true;
      })();
      return closePromise;
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
