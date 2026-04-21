/**
 * Plan 2 startup recovery — synchronous pass over pending_blob_puts rows
 * and blob_ready=0 artifact rows left by a previous crash.
 *
 * This is a minimal subset of the full recovery described in spec §6.5.
 * Plan 4 extends with a background worker for ongoing repair and adds
 * TTL-on-open, scavenger, and the full tombstone Phase B drain. Plan 2
 * handles the two "crashed mid-save" shapes so saves never silently strand
 * invisible rows.
 *
 * Recovery matches intents to artifact rows by `artifact_id` (populated by
 * saveArtifact once its metadata tx inserts the row). This avoids the
 * hash-collapse bug where a concurrent same-content save with a completed
 * blob_ready=1 row would fool recovery into retiring the earlier save's
 * intent — leaving the earlier row permanently blob_ready=0.
 *
 * Durability contract: a single negative `has()` probe NEVER terminally
 * deletes a row. `repair_attempts` is incremented on each confirmed miss
 * and only at >= maxRepairAttempts do we tombstone the hash and delete the
 * row. That tolerates transient backend outages during restart — a backend
 * that's down right now will hit has=false, increment the counter, and
 * leave the row for the next attempt. Only persistent missing-blob errors
 * (10 restarts with confirmed absence, by default) trigger terminal loss.
 *
 * Behavior (per pending_blob_puts row, oldest first):
 *   - artifact_id IS NULL → save crashed before its metadata tx committed.
 *     Tombstone the hash if no live ref, retire the intent.
 *   - artifact_id set, row missing → row was externally deleted after the
 *     intent was bound. Retire the intent.
 *   - artifact_id set, row blob_ready=1 → save completed past the UPDATE but
 *     before retiring the intent. Retire the intent.
 *   - artifact_id set, row blob_ready=0 → crashed between COMMIT and UPDATE.
 *     If blob is present, promote. If missing, increment repair_attempts;
 *     only delete at the maxRepairAttempts threshold.
 */

import type { Database } from "bun:sqlite";
import type { BlobStore } from "@koi/blob-cas";

const DEFAULT_MAX_REPAIR_ATTEMPTS = 10;

interface IntentRow {
  readonly intent_id: string;
  readonly hash: string;
  readonly artifact_id: string | null;
}

interface TargetRow {
  readonly blob_ready: number;
  readonly repair_attempts: number;
}

export async function runStartupRecovery(args: {
  readonly db: Database;
  readonly blobStore: BlobStore;
  readonly maxRepairAttempts?: number;
}): Promise<void> {
  const maxAttempts = args.maxRepairAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS;
  // Pass 1: walk pending_blob_puts (the normal case for Plan 2 saves).
  await drainPendingIntents({ ...args, maxAttempts });

  // Pass 2: sweep any blob_ready=0 rows that have NO remaining intent.
  // This catches rows stranded by an earlier iteration's hash-collapse bug
  // or by any external mutation that dropped the intent without resolving
  // the row. Every hidden row is either promoted, has its repair_attempts
  // bumped (for transient outages), or terminal-deleted after max attempts.
  await drainOrphanedHiddenRows({ ...args, maxAttempts });
}

interface OrphanRowWithAttempts {
  readonly id: string;
  readonly content_hash: string;
  readonly repair_attempts: number;
}

async function drainOrphanedHiddenRows(args: {
  readonly db: Database;
  readonly blobStore: BlobStore;
  readonly maxAttempts: number;
}): Promise<void> {
  const rows = args.db
    .query(
      `SELECT id, content_hash, repair_attempts FROM artifacts
        WHERE blob_ready = 0
          AND NOT EXISTS (SELECT 1 FROM pending_blob_puts WHERE artifact_id = artifacts.id)`,
    )
    .all() as ReadonlyArray<OrphanRowWithAttempts>;

  for (const row of rows) {
    const blobPresent = await args.blobStore.has(row.content_hash);
    if (blobPresent) {
      args.db
        .query("UPDATE artifacts SET blob_ready = 1 WHERE id = ? AND blob_ready = 0")
        .run(row.id);
      continue;
    }

    // Confirmed missing — bump repair_attempts and only terminal-delete
    // if we've hit the budget. A single negative probe during a transient
    // backend outage must NOT reap a committed save.
    const nextAttempts = row.repair_attempts + 1;
    if (nextAttempts < args.maxAttempts) {
      args.db
        .query("UPDATE artifacts SET repair_attempts = ? WHERE id = ? AND blob_ready = 0")
        .run(nextAttempts, row.id);
      continue;
    }

    // Budget exhausted: the blob has been confirmed absent N times across
    // restarts. Terminal-delete + tombstone.
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

async function drainPendingIntents(args: {
  readonly db: Database;
  readonly blobStore: BlobStore;
  readonly maxAttempts: number;
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
      .query("SELECT blob_ready, repair_attempts FROM artifacts WHERE id = ?")
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
      continue;
    }

    // Blob confirmed absent — bump repair_attempts. A single negative probe
    // during transient backend outage must NOT reap a committed save. Only
    // terminal-delete once repair_attempts has accumulated to the budget.
    const nextAttempts = target.repair_attempts + 1;
    if (nextAttempts < args.maxAttempts) {
      args.db
        .query("UPDATE artifacts SET repair_attempts = ? WHERE id = ? AND blob_ready = 0")
        .run(nextAttempts, intent.artifact_id);
      continue;
    }

    // Budget exhausted: terminal delete + tombstone + retire intent.
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
