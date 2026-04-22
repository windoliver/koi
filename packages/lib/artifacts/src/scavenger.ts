/**
 * `scavengeOrphanBlobs()` — spec §6.4.
 *
 * Disaster-recovery utility. If SQLite is truncated / restored from backup,
 * tombstones can be lost while their blobs linger on disk. The scavenger
 * rebuilds the tombstone journal by walking `blobStore.list()`, then hands
 * every candidate to Phase B (§6.3). It NEVER deletes blobs directly —
 * every reclamation flows through the same claim/delete/reconcile protocol
 * sweepArtifacts uses, so the race rules (save-reclaims-tombstone,
 * resume-from-claimed, pending_blob_puts protection) apply unchanged.
 *
 * Flow:
 *   1. pass1_live = DISTINCT hashes from
 *        artifacts.content_hash
 *      ∪ pending_blob_deletes.hash
 *      ∪ pending_blob_puts.hash
 *      Snapshotted inside a single BEGIN IMMEDIATE so the three-table read
 *      is atomic — concurrent saves/sweeps cannot make us see a partial view.
 *   2. Iterate blobStore.list() OUTSIDE any DB transaction. Every hash that
 *      misses pass1_live goes onto `candidates`. list() can be slow (S3
 *      pagination, large FS walks) — no SQLite lock may be held during it.
 *   3. BEGIN IMMEDIATE; INSERT OR IGNORE each candidate into
 *      `pending_blob_deletes(hash, enqueued_at, claimed_at=NULL)`; COMMIT.
 *      IGNORE is load-bearing: a save may have enqueued a tombstone for the
 *      same hash between pass1_live and this step (unlikely but benign).
 *   4. drainPendingBlobDeletes() — Phase B. Its claim predicate
 *      (NOT EXISTS artifacts AND NOT EXISTS pending_blob_puts) rejects any
 *      hash that became live between pass1_live and now, so a save that
 *      journaled its intent AFTER pass1_live keeps its blob. The stale
 *      candidate tombstone is cleaned up by claimTombstone's orphan-gone
 *      fallback.
 *
 * bytesReclaimed: Plan 3 returns 0 as a known limitation. BlobStore.list()
 * yields only hashes, and we deliberately don't `get()` each deleted blob
 * just to measure its size — that would double every scavenger pass's I/O
 * on an S3 backend. Operators who need exact bytes-reclaimed accounting can
 * query `du` on the blob dir before and after. See Plan 4 for streaming
 * size-aware enumeration.
 *
 * O(N) over the blob store. Operator-run, not hot-path.
 */

import type { Database } from "bun:sqlite";
import type { BlobStore } from "@koi/blob-cas";
import { createDrainTombstones } from "./drain-tombstones.js";

export interface ScavengeResult {
  readonly deleted: number;
  readonly bytesReclaimed: number;
}

interface HashRow {
  readonly hash: string;
}

function snapshotLiveHashes(db: Database): ReadonlySet<string> {
  const tx = db.transaction((): ReadonlySet<string> => {
    const rows = db
      .query(
        `SELECT content_hash AS hash FROM artifacts
         UNION
         SELECT hash FROM pending_blob_deletes
         UNION
         SELECT hash FROM pending_blob_puts`,
      )
      .all() as ReadonlyArray<HashRow>;
    return new Set(rows.map((r) => r.hash));
  });
  return tx();
}

function enqueueCandidates(db: Database, candidates: ReadonlyArray<string>, now: number): void {
  if (candidates.length === 0) return;
  const tx = db.transaction((): void => {
    const stmt = db.query(
      "INSERT OR IGNORE INTO pending_blob_deletes (hash, enqueued_at) VALUES (?, ?)",
    );
    for (const hash of candidates) {
      stmt.run(hash, now);
    }
  });
  tx();
}

export function createScavengerOrphanBlobs(args: {
  readonly db: Database;
  readonly blobStore: BlobStore;
}): () => Promise<ScavengeResult> {
  const drain = createDrainTombstones({ db: args.db, blobStore: args.blobStore });

  return async () => {
    // Step 1: atomic snapshot of live-hash set.
    const live = snapshotLiveHashes(args.db);

    // Step 2: walk blobs with NO DB lock held. list() may be slow/remote.
    const candidates: Array<string> = [];
    for await (const hash of args.blobStore.list()) {
      if (live.has(hash)) continue;
      candidates.push(hash);
    }

    // Step 3: journal candidates. INSERT OR IGNORE tolerates any concurrent
    // sweep that tombstoned the same hash between pass1_live and now.
    enqueueCandidates(args.db, candidates, Date.now());

    // Step 4: Phase B drives the race-safe claim/delete/reconcile. Any
    // candidate whose hash became live via a post-snapshot save is rejected
    // at the claim step and the stale tombstone cleaned up.
    const result = await drain();

    // bytesReclaimed: see header comment — intentionally 0 in Plan 3.
    return { deleted: result.reclaimed, bytesReclaimed: 0 };
  };
}
