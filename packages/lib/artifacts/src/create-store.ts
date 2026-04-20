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
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type BlobStore, createFilesystemBlobStore } from "@koi/blob-cas";
import type { ArtifactId, SessionId } from "@koi/core";
import { createDeleteArtifact } from "./delete.js";
import { createGetArtifact } from "./get.js";
import { createListArtifacts } from "./list.js";
import { acquireLock, isInMemoryDbPath } from "./lock.js";
import { validateLifecyclePolicy } from "./policy.js";
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
  // Defense in depth: the public type does not declare blobStore, but a JS
  // caller can still smuggle it in. Reject loudly rather than silently
  // ignore — Plan 5 (#1922) adds pluggable backends with remote-backend
  // sentinel pairing.
  const smuggled = config as unknown as { readonly blobStore?: unknown };
  if (smuggled.blobStore !== undefined) {
    throw new Error(
      "ArtifactStoreConfig.blobStore is not supported in Plan 2 — use the default FS backend via blobDir. Plan 5 (#1922) adds pluggable backends with remote-backend sentinel pairing.",
    );
  }

  validateLifecyclePolicy(config.policy);

  if (config.maxRepairAttempts !== undefined) {
    if (
      !Number.isFinite(config.maxRepairAttempts) ||
      !Number.isInteger(config.maxRepairAttempts) ||
      config.maxRepairAttempts < 1
    ) {
      throw new Error(
        `ArtifactStoreConfig.maxRepairAttempts must be a finite integer >= 1; got ${String(config.maxRepairAttempts)}. A zero/negative/NaN value would collapse the retry budget and terminal-delete committed saves on the first missing-blob probe.`,
      );
    }
  }
  if (config.maxArtifactBytes !== undefined) {
    if (
      !Number.isFinite(config.maxArtifactBytes) ||
      !Number.isInteger(config.maxArtifactBytes) ||
      config.maxArtifactBytes < 1
    ) {
      throw new Error(
        `ArtifactStoreConfig.maxArtifactBytes must be a finite integer >= 1; got ${String(config.maxArtifactBytes)}. A zero value would cause every non-empty save to fail with invalid_input — surface the misconfiguration at startup instead.`,
      );
    }
  }

  // Reject non-memory SQLite URI paths. The advisory lock and mkdir logic
  // operate on filesystem paths; `file:/tmp/x.db?cache=shared` is a valid
  // SQLite URI but not a filesystem path — its lock file would land at
  // `file:/tmp/x.db?cache=shared.lock` (wrong namespace) and dirname()
  // would resolve to `file:/tmp` (junk local dir). Plan 2 supports bare
  // filesystem paths and in-memory forms only; Plan 4 may add full URI
  // support alongside flock.
  if (
    !isInMemoryDbPath(config.dbPath) &&
    (config.dbPath.startsWith("file:") || config.dbPath.startsWith("file://"))
  ) {
    throw new Error(
      `ArtifactStoreConfig.dbPath: non-memory SQLite URI paths (${config.dbPath}) are not supported in Plan 2. Use a bare filesystem path (e.g. "/tmp/store.db") or an in-memory form (":memory:", "file::memory:", "file:name?mode=memory").`,
    );
  }

  // Ensure the blob directory and the DB's containing directory exist
  // before lock acquisition writes its tmp files. A brand-new store open
  // should succeed without requiring the caller to pre-create directories.
  mkdirSync(config.blobDir, { recursive: true });
  if (!isInMemoryDbPath(config.dbPath)) {
    mkdirSync(dirname(config.dbPath), { recursive: true });
  }

  const releaseLock = acquireLock(config.dbPath, config.blobDir);

  let db: Database | undefined;
  try {
    db = openDatabase(config);
    const blobStore: BlobStore = createFilesystemBlobStore(config.blobDir);
    await ensureStoreIdPair({ db, blobDir: config.blobDir, blobStore });

    // Startup recovery: resolve blob_ready=0 rows and stale pending_blob_puts
    // rows left by a previous crash. Runs synchronously so the store is in a
    // consistent state before first use. Uses repair_attempts budget so a
    // single negative probe during transient backend outage does not reap a
    // committed save.
    await runStartupRecovery({
      db,
      blobStore,
      ...(config.maxRepairAttempts !== undefined
        ? { maxRepairAttempts: config.maxRepairAttempts }
        : {}),
    });

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
