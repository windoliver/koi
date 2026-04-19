/**
 * Plan 2 startup recovery — synchronous pass over pending_blob_puts rows
 * and blob_ready=0 artifact rows left by a previous crash.
 *
 * This is a minimal subset of the full recovery described in spec §6.5.
 * Plan 4 extends with a background worker for ongoing repair and adds
 * TTL-on-open, scavenger, and the full tombstone Phase B drain. Plan 2 only
 * handles the two "crashed mid-save" shapes so saves never silently strand
 * invisible rows.
 *
 * Behavior (per pending_blob_puts row, oldest first):
 *   - Matching blob_ready=1 row → intent is stale (save completed before
 *     retiring the intent). Delete intent.
 *   - Matching blob_ready=0 row → save committed metadata but crashed before
 *     the blob_ready=1 UPDATE. If the blob is present, promote. If the blob
 *     is missing, delete the row + tombstone the hash.
 *   - No matching artifact row → save crashed before its metadata tx
 *     committed. Delete intent. If no live ref to the hash exists, enqueue
 *     a tombstone so the orphan blob (if any) can be reclaimed.
 */

import type { Database } from "bun:sqlite";
import type { BlobStore } from "@koi/blob-cas";

interface IntentRow {
  readonly intent_id: string;
  readonly hash: string;
}

interface MatchRow {
  readonly id: string;
  readonly blob_ready: number;
}

export async function runStartupRecovery(args: {
  readonly db: Database;
  readonly blobStore: BlobStore;
}): Promise<void> {
  const intents = args.db
    .query("SELECT intent_id, hash FROM pending_blob_puts ORDER BY created_at")
    .all() as ReadonlyArray<IntentRow>;

  for (const intent of intents) {
    const match = args.db
      .query(
        "SELECT id, blob_ready FROM artifacts WHERE content_hash = ? ORDER BY blob_ready DESC LIMIT 1",
      )
      .get(intent.hash) as MatchRow | null;

    if (match && match.blob_ready === 1) {
      // Save completed but the intent retirement didn't run. Retire now.
      args.db.query("DELETE FROM pending_blob_puts WHERE intent_id = ?").run(intent.intent_id);
      continue;
    }

    if (match && match.blob_ready === 0) {
      // Crash between COMMIT and blob_ready=1 UPDATE.
      const blobPresent = await args.blobStore.has(intent.hash);
      if (blobPresent) {
        args.db.query("UPDATE artifacts SET blob_ready = 1 WHERE id = ?").run(match.id);
        args.db.query("DELETE FROM pending_blob_puts WHERE intent_id = ?").run(intent.intent_id);
      } else {
        // Blob missing. Row is unrecoverable — delete it and queue the
        // (possibly orphan) hash for sweep.
        args.db.transaction(() => {
          args.db.query("DELETE FROM artifacts WHERE id = ?").run(match.id);
          const stillReferenced = args.db
            .query(`SELECT 1 WHERE EXISTS (SELECT 1 FROM artifacts WHERE content_hash = ?)`)
            .get(intent.hash);
          if (!stillReferenced) {
            args.db
              .query(
                "INSERT INTO pending_blob_deletes (hash, enqueued_at) VALUES (?, ?) ON CONFLICT DO NOTHING",
              )
              .run(intent.hash, Date.now());
          }
          args.db.query("DELETE FROM pending_blob_puts WHERE intent_id = ?").run(intent.intent_id);
        })();
      }
      continue;
    }

    // No artifact row references the hash — save crashed before its metadata
    // tx committed. Tombstone the orphan blob (if any) and retire the intent.
    args.db.transaction(() => {
      const stillReferenced = args.db
        .query(
          `SELECT 1 WHERE EXISTS (SELECT 1 FROM artifacts WHERE content_hash = ?)
                        OR EXISTS (SELECT 1 FROM pending_blob_puts WHERE hash = ? AND intent_id != ?)`,
        )
        .get(intent.hash, intent.hash, intent.intent_id);
      if (!stillReferenced) {
        args.db
          .query(
            "INSERT INTO pending_blob_deletes (hash, enqueued_at) VALUES (?, ?) ON CONFLICT DO NOTHING",
          )
          .run(intent.hash, Date.now());
      }
      args.db.query("DELETE FROM pending_blob_puts WHERE intent_id = ?").run(intent.intent_id);
    })();
  }
}
