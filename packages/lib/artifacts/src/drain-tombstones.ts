/**
 * Phase B tombstone drain — spec §6.3.
 *
 * Three tiny transactions per tombstone, with blob I/O between them and NO
 * SQLite write lock held while deleting bytes:
 *
 *   1. Claim tx   — UPDATE ... SET claimed_at = now WHERE hash = ?
 *                   AND claimed_at IS NULL
 *                   AND no live artifacts row references the hash
 *                   AND no pending_blob_puts intent references the hash.
 *                   0 rows affected → either tombstone already claimed
 *                   (resume-from-claimed, handled separately on first scan)
 *                   or the blob is re-live (save reclaimed / another
 *                   artifact still points at it). In the latter case we
 *                   DELETE the tombstone if the orphan condition no longer
 *                   holds — keeps the journal trim.
 *
 *   2. Blob I/O   — blobStore.delete(hash). Runs outside every DB lock.
 *                   ENOENT / 404 = success (idempotent). Anything else
 *                   leaves the tombstone with claimed_at set; next drain
 *                   picks it up via the resume-from-claimed rule.
 *
 *   3. Reconcile  — DELETE FROM pending_blob_deletes WHERE hash = ?.
 *                   If 0 rows affected, a concurrent saveArtifact reclaimed
 *                   the tombstone between steps 1 and 3. The save's
 *                   post-commit unconditional put (§6.1 step 7) has or will
 *                   re-create the bytes; correctness preserved.
 *
 * Resume-from-claimed: when the drain starts and sees claimed_at != NULL on
 * an existing row, that row crashed between claim and reconcile in a prior
 * run. Skip the claim tx and go straight to the blob delete + reconcile —
 * the durable claim already guarantees no save can slip through unnoticed
 * (its tombstone-reclaim sees claimed_at != NULL and forces needsRePut in
 * its own post-commit repair).
 */

import type { Database } from "bun:sqlite";
import type { BlobStore } from "@koi/blob-cas";

export interface DrainTombstonesResult {
  readonly reclaimed: number;
}

interface TombstoneRow {
  readonly hash: string;
  readonly claimed_at: number | null;
}

function claimTombstone(db: Database, hash: string, now: number): boolean {
  const tx = db.transaction((): boolean => {
    const res = db
      .query(
        `UPDATE pending_blob_deletes
            SET claimed_at = ?
          WHERE hash = ?
            AND claimed_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM artifacts WHERE content_hash = ?)
            AND NOT EXISTS (SELECT 1 FROM pending_blob_puts WHERE hash = ?)`,
      )
      .run(now, hash, hash, hash);
    if (res.changes > 0) return true;

    // Claim failed — either blob is re-live or tombstone already removed
    // by a concurrent drain. If the orphan condition no longer holds, sweep
    // the stale tombstone so the journal doesn't grow unboundedly.
    db.query(
      `DELETE FROM pending_blob_deletes
        WHERE hash = ?
          AND (EXISTS (SELECT 1 FROM artifacts WHERE content_hash = ?)
            OR EXISTS (SELECT 1 FROM pending_blob_puts WHERE hash = ?))`,
    ).run(hash, hash, hash);
    return false;
  });
  return tx();
}

function reconcileTombstone(db: Database, hash: string): number {
  const tx = db.transaction((): number => {
    const res = db.query("DELETE FROM pending_blob_deletes WHERE hash = ?").run(hash);
    return res.changes;
  });
  return tx();
}

async function deleteBlobIdempotent(blobStore: BlobStore, hash: string): Promise<void> {
  // The FS impl returns false for ENOENT (no throw); the contract makes
  // that a valid success signal. S3/future backends may map 404 to the
  // same false return. Any thrown error is a transient failure — let it
  // propagate; the outer loop leaves the tombstone with claimed_at set so
  // the next drain can resume-from-claimed.
  await blobStore.delete(hash);
}

export function createDrainTombstones(args: {
  readonly db: Database;
  readonly blobStore: BlobStore;
}): () => Promise<DrainTombstonesResult> {
  return async () => {
    // Snapshot the ordered pending set once. Concurrent saves may reclaim
    // rows while we iterate — each step tolerates that via its own checks.
    const rows = args.db
      .query("SELECT hash, claimed_at FROM pending_blob_deletes ORDER BY enqueued_at, hash")
      .all() as ReadonlyArray<TombstoneRow>;

    let reclaimed = 0;
    for (const row of rows) {
      // Resume-from-claimed: durable claim already survived a crash. Skip
      // the re-claim attempt — the claim is still valid — and fall through
      // to blob delete + reconcile.
      if (row.claimed_at === null) {
        const now = Date.now();
        const claimed = claimTombstone(args.db, row.hash, now);
        if (!claimed) continue;
      }

      try {
        await deleteBlobIdempotent(args.blobStore, row.hash);
      } catch {
        // Transient failure. Tombstone retains claimed_at; next drain
        // resumes via resume-from-claimed. Don't propagate — keep draining
        // sibling tombstones; they may be unaffected.
        continue;
      }

      const changes = reconcileTombstone(args.db, row.hash);
      if (changes > 0) reclaimed++;
      // changes === 0 means a concurrent saveArtifact reclaimed this
      // tombstone between our claim and now; its post-commit repair will
      // handle bytes. Still-correct outcome.
    }

    return { reclaimed };
  };
}
