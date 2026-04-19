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
 * Recovery matches intents to artifact rows by `artifact_id` (populated by
 * saveArtifact once its metadata tx inserts the row). This avoids the
 * hash-collapse bug where a concurrent same-content save with a completed
 * blob_ready=1 row would fool recovery into retiring the earlier save's
 * intent — leaving the earlier row permanently blob_ready=0.
 *
 * Behavior (per pending_blob_puts row, oldest first):
 *   - artifact_id IS NULL → save crashed before its metadata tx committed.
 *     Tombstone the hash if no live ref, retire the intent.
 *   - artifact_id set, row missing → row was externally deleted after the
 *     intent was bound. Retire the intent.
 *   - artifact_id set, row blob_ready=1 → save completed past the UPDATE but
 *     before retiring the intent. Retire the intent.
 *   - artifact_id set, row blob_ready=0 → crashed between COMMIT and the
 *     UPDATE. If blob is present, promote. If missing, delete row + tombstone.
 */

import type { Database } from "bun:sqlite";
import type { BlobStore } from "@koi/blob-cas";

interface IntentRow {
  readonly intent_id: string;
  readonly hash: string;
  readonly artifact_id: string | null;
}

interface TargetRow {
  readonly blob_ready: number;
}

export async function runStartupRecovery(args: {
  readonly db: Database;
  readonly blobStore: BlobStore;
}): Promise<void> {
  // Pass 1: walk pending_blob_puts (the normal case for Plan 2 saves).
  await drainPendingIntents(args);

  // Pass 2: sweep any blob_ready=0 rows that have NO remaining intent.
  // This catches rows stranded by an earlier iteration's hash-collapse bug
  // or by any external mutation that dropped the intent without resolving
  // the row. Every hidden row is either promoted or reaped.
  await drainOrphanedHiddenRows(args);
}

interface OrphanRow {
  readonly id: string;
  readonly content_hash: string;
}

async function drainOrphanedHiddenRows(args: {
  readonly db: Database;
  readonly blobStore: BlobStore;
}): Promise<void> {
  const rows = args.db
    .query(
      `SELECT id, content_hash FROM artifacts
        WHERE blob_ready = 0
          AND NOT EXISTS (SELECT 1 FROM pending_blob_puts WHERE artifact_id = artifacts.id)`,
    )
    .all() as ReadonlyArray<OrphanRow>;

  for (const row of rows) {
    const blobPresent = await args.blobStore.has(row.content_hash);
    if (blobPresent) {
      args.db
        .query("UPDATE artifacts SET blob_ready = 1 WHERE id = ? AND blob_ready = 0")
        .run(row.id);
    } else {
      args.db.transaction(() => {
        args.db.query("DELETE FROM artifacts WHERE id = ?").run(row.id);
        const stillReferenced = args.db
          .query(
            `SELECT 1 WHERE EXISTS (SELECT 1 FROM artifacts WHERE content_hash = ?)
                          OR EXISTS (SELECT 1 FROM pending_blob_puts WHERE hash = ?)`,
          )
          .get(row.content_hash, row.content_hash);
        if (!stillReferenced) {
          args.db
            .query(
              "INSERT INTO pending_blob_deletes (hash, enqueued_at) VALUES (?, ?) ON CONFLICT DO NOTHING",
            )
            .run(row.content_hash, Date.now());
        }
      })();
    }
  }
}

async function drainPendingIntents(args: {
  readonly db: Database;
  readonly blobStore: BlobStore;
}): Promise<void> {
  const intents = args.db
    .query("SELECT intent_id, hash, artifact_id FROM pending_blob_puts ORDER BY created_at")
    .all() as ReadonlyArray<IntentRow>;

  for (const intent of intents) {
    // Case A: intent never bound to a row (save crashed before metadata tx).
    if (intent.artifact_id === null) {
      args.db.transaction(() => {
        const stillReferenced = args.db
          .query(
            `SELECT 1 WHERE EXISTS (SELECT 1 FROM artifacts WHERE content_hash = ?)
                          OR EXISTS (SELECT 1 FROM pending_blob_puts
                                      WHERE hash = ? AND intent_id != ?)`,
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
      continue;
    }

    // Intent is bound to a specific row. Look it up.
    const target = args.db
      .query("SELECT blob_ready FROM artifacts WHERE id = ?")
      .get(intent.artifact_id) as TargetRow | null;

    if (target === null) {
      // Row was externally deleted after the intent was bound. The blob
      // may still be on disk with no metadata references — tombstone it
      // (if unreferenced) before retiring the intent so no orphan leaks.
      args.db.transaction(() => {
        const stillReferenced = args.db
          .query(
            `SELECT 1 WHERE EXISTS (SELECT 1 FROM artifacts WHERE content_hash = ?)
                          OR EXISTS (SELECT 1 FROM pending_blob_puts
                                      WHERE hash = ? AND intent_id != ?)`,
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
      continue;
    }

    if (target.blob_ready === 1) {
      // Save completed past the UPDATE; intent retirement was lost. Retire now.
      args.db.query("DELETE FROM pending_blob_puts WHERE intent_id = ?").run(intent.intent_id);
      continue;
    }

    // target.blob_ready === 0 → crash between COMMIT and UPDATE blob_ready=1.
    const blobPresent = await args.blobStore.has(intent.hash);
    if (blobPresent) {
      args.db.query("UPDATE artifacts SET blob_ready = 1 WHERE id = ?").run(intent.artifact_id);
      args.db.query("DELETE FROM pending_blob_puts WHERE intent_id = ?").run(intent.intent_id);
    } else {
      // Blob missing: row is unrecoverable. Delete + tombstone + retire intent.
      args.db.transaction(() => {
        args.db.query("DELETE FROM artifacts WHERE id = ?").run(intent.artifact_id);
        const stillReferenced = args.db
          .query(
            `SELECT 1 WHERE EXISTS (SELECT 1 FROM artifacts WHERE content_hash = ?)
                          OR EXISTS (SELECT 1 FROM pending_blob_puts
                                      WHERE hash = ? AND intent_id != ?)`,
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
}
