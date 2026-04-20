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
import { createScavengerOrphanBlobs } from "./scavenger.js";
import { createRevokeShare, createShareArtifact } from "./share.js";
import { openDatabase } from "./sqlite.js";
import { ensureStoreIdPair } from "./store-id.js";
import { createSweepArtifacts, sweepTtlOnOpen } from "./sweep.js";
import type {
  Artifact,
  ArtifactError,
  ArtifactFilter,
  ArtifactStore,
  ArtifactStoreConfig,
  Result,
  SaveArtifactInput,
  ScavengeOrphanBlobsResult,
  SweepArtifactsResult,
} from "./types.js";
import { createRepairWorker } from "./worker.js";

export async function createArtifactStore(config: ArtifactStoreConfig): Promise<ArtifactStore> {
  // Plan 5: `blobStore` override is public. When provided, the store uses it
  // verbatim and skips FS-specific bootstrap (`mkdirSync(blobDir, ...)`,
  // default filesystem factory). `blobDir` is still required for the default
  // FS backend (both as the blob root and as the lock-file directory).
  // Resolve the backend choice once up front so downstream code can trust it
  // without re-asserting the `blobStore === undefined → blobDir defined`
  // invariant at every use site.
  const resolvedBackend:
    | { readonly kind: "override"; readonly store: BlobStore }
    | {
        readonly kind: "filesystem";
        readonly blobDir: string;
      } = (() => {
    if (config.blobStore !== undefined) {
      return { kind: "override", store: config.blobStore };
    }
    if (config.blobDir !== undefined) {
      return { kind: "filesystem", blobDir: config.blobDir };
    }
    throw new Error(
      "ArtifactStoreConfig requires either `blobDir` (for the default filesystem backend) or `blobStore` (for a pluggable backend).",
    );
  })();

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
  if (config.staleIntentGraceMs !== undefined) {
    if (
      !Number.isFinite(config.staleIntentGraceMs) ||
      !Number.isInteger(config.staleIntentGraceMs) ||
      config.staleIntentGraceMs < 0
    ) {
      throw new Error(
        `ArtifactStoreConfig.staleIntentGraceMs must be a finite integer >= 0; got ${String(config.staleIntentGraceMs)}. Negative/NaN/fractional values are rejected at construction so misconfiguration surfaces before a recovery pass.`,
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
  if (config.workerIntervalMs !== undefined && config.workerIntervalMs !== "manual") {
    if (
      !Number.isFinite(config.workerIntervalMs) ||
      !Number.isInteger(config.workerIntervalMs) ||
      config.workerIntervalMs < 100
    ) {
      throw new Error(
        `ArtifactStoreConfig.workerIntervalMs must be a finite integer >= 100 or the literal "manual"; got ${String(config.workerIntervalMs)}. Values below 100ms starve save/get transactions with BEGIN IMMEDIATE contention; fractional/NaN/negative values are rejected to surface misconfiguration at startup.`,
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

  // Ensure the DB's containing directory exists before lock acquisition writes
  // its tmp files. For the default FS backend, also pre-create `blobDir`. For
  // a `blobStore` override, the backend owns its own root; we only need a
  // filesystem directory for the advisory-lock tmp file (alongside the DB).
  if (!isInMemoryDbPath(config.dbPath)) {
    mkdirSync(dirname(config.dbPath), { recursive: true });
  }
  if (resolvedBackend.kind === "filesystem") {
    mkdirSync(resolvedBackend.blobDir, { recursive: true });
  }

  // The filesystem blobDir-lock (spec §3.0 Layer 1a) is a defense against two
  // :memory: DBs sharing a single local blob directory. For a pluggable
  // `blobStore`, the backend's own store-id sentinel (Layer 2) is the
  // corresponding defense — no local-filesystem lock applies. `acquireLock`
  // skips its Layer-1a lock when `blobDir` is undefined.
  const releaseLock = acquireLock(
    config.dbPath,
    resolvedBackend.kind === "filesystem" ? resolvedBackend.blobDir : undefined,
  );

  let db: Database | undefined;
  try {
    db = openDatabase(config);
    const blobStore: BlobStore =
      resolvedBackend.kind === "override"
        ? resolvedBackend.store
        : createFilesystemBlobStore(resolvedBackend.blobDir);
    await ensureStoreIdPair({ db, blobStore });

    // Startup recovery (spec §6.5 Plan 4): local SQLite DML only. Drains
    // stale pending_blob_puts and resolves the subset of bound intents that
    // need no backend probe. blob_ready=0 rows with a bound intent are
    // left untouched for the background worker (Plan 4 tasks 3-5). The
    // open path must never call blobStore.has/put/delete — a transient S3
    // outage on restart would otherwise either stall bootstrap or erode a
    // committed save's retry budget.
    runStartupRecovery({
      db,
      ...(config.staleIntentGraceMs !== undefined
        ? { staleIntentGraceMs: config.staleIntentGraceMs }
        : {}),
    });

    // Spec §6.5 step 3: TTL-only Phase A sweep. Local DML only. Reaps rows
    // whose per-row frozen `expires_at` is already in the past; enqueues
    // tombstones for hashes whose only references were inside the deletion
    // set. Tombstones are drained later by the background worker. Quota
    // and per-name retention are deliberately NOT applied here — a
    // stricter policy or rollback must not silently delete previously
    // valid artifacts just because the process restarted.
    sweepTtlOnOpen({ db, now: Date.now() });

    // Spec §6.5 step 4: background repair worker. `start()` arms the
    // iteration loop (or is a no-op for `workerIntervalMs = "manual"`). The
    // worker owns every `blob_ready = 0` row that survived startup recovery
    // plus Phase B tombstone drain — see worker.ts header. The default
    // terminal-delete budget (10) matches the docstring on
    // `ArtifactStoreConfig.maxRepairAttempts`.
    const worker = createRepairWorker({
      db,
      blobStore,
      config,
      maxRepairAttempts: config.maxRepairAttempts ?? 10,
      // exactOptionalPropertyTypes: conditionally spread so we never pass
      // `onEvent: undefined` through — the worker treats absent and
      // `undefined` identically, but spreading matches the interface shape.
      ...(config.onEvent !== undefined ? { onEvent: config.onEvent } : {}),
    });
    worker.start();

    const rawSave = createSaveArtifact({ db, blobStore, config });
    const rawGet = createGetArtifact({ db, blobStore });
    const rawList = createListArtifacts({ db });
    const rawDelete = createDeleteArtifact({ db });
    const rawShare = createShareArtifact({ db });
    const rawRevoke = createRevokeShare({ db });
    const rawSweep = createSweepArtifacts({
      db,
      blobStore,
      ...(config.policy !== undefined ? { policy: config.policy } : {}),
    });
    const rawScavenge = createScavengerOrphanBlobs({ db, blobStore });

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
    const sweepArtifacts: () => Promise<SweepArtifactsResult> = track(rawSweep);
    const scavengeOrphanBlobs: () => Promise<ScavengeOrphanBlobsResult> = track(rawScavenge);

    const close = async (): Promise<void> => {
      if (closed) return;
      // Memoize the first close's work so concurrent callers share it.
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        // Tear down the repair worker first: cancels future ticks and awaits
        // any in-flight iteration so its blob probes + per-row DB txs finish
        // before we close the SQLite handle. `stop()` is idempotent and
        // memoizes its own drain promise — concurrent close() callers share
        // one underlying drain. See worker.ts header for the stop() contract.
        await worker.stop();
        // Wait for in-flight public-API ops to drain. No timeout — a stuck
        // blob I/O must finish before ownership is released; otherwise a new
        // owner could race the old owner's pending writes.
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
      sweepArtifacts,
      scavengeOrphanBlobs,
      close,
    };
  } catch (err) {
    db?.close();
    releaseLock();
    throw err;
  }
}
