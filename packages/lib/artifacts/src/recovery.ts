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

/**
 * Default grace window for the §6.5 step 1 stale-intent drain: 5 minutes.
 *
 * This is a SAFETY bound, not a liveness tuning knob. It must exceed the
 * worst-case save latency so a concurrent startup recovery pass never
 * converts a real in-flight save's intent into a tombstone. With a
 * filesystem backend, 5 minutes is absurdly generous; with a slow S3
 * region under load, a multi-GB upload might still complete inside this
 * window. Operators can raise it via ArtifactStoreConfig.staleIntentGraceMs
 * but should never set it below observed p99 save latency for their
 * deployment.
 */
const DEFAULT_STALE_INTENT_GRACE_MS = 5 * 60 * 1000;

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
  readonly staleIntentGraceMs?: number;
}): Promise<void> {
  const maxAttempts = args.maxRepairAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS;
  const staleIntentGraceMs = args.staleIntentGraceMs ?? DEFAULT_STALE_INTENT_GRACE_MS;

  // Spec §6.5 step 1: convert stale pre-commit intents (older than the
  // grace window) directly into sweep tombstones (or drop them outright
  // when an artifacts row already references the hash). This is local
  // DML only — no blob I/O — and must run before any subsequent pass
  // that might observe a now-resolved intent.
  drainStalePendingIntents({
    db: args.db,
    staleIntentGraceMs,
    now: Date.now(),
  });

  // Pass 1: walk pending_blob_puts (the normal case for Plan 2 saves).
  await drainPendingIntents({ ...args, maxAttempts });

  // Pass 2: sweep any blob_ready=0 rows that have NO remaining intent.
  // This catches rows stranded by an earlier iteration's hash-collapse bug
  // or by any external mutation that dropped the intent without resolving
  // the row. Every hidden row is either promoted, has its repair_attempts
  // bumped (for transient outages), or terminal-deleted after max attempts.
  await drainOrphanedHiddenRows({ ...args, maxAttempts });
}

interface StaleIntentRow {
  readonly intent_id: string;
  readonly hash: string;
}

/**
 * Spec §6.5 step 1: drain `pending_blob_puts` rows older than the grace
 * window. Each stale intent is resolved atomically inside a short
 * `BEGIN IMMEDIATE` transaction:
 *   - If an `artifacts` row references the hash (any blob_ready state),
 *     just `DELETE FROM pending_blob_puts WHERE intent_id = ?`. The row's
 *     own repair path (drainPendingIntents + drainOrphanedHiddenRows) owns
 *     resolution; there is nothing for this step to reclaim.
 *   - Otherwise, DELETE the intent AND
 *     `INSERT OR IGNORE INTO pending_blob_deletes` the hash so the normal
 *     sweep's Phase B drain reclaims the orphan blob (no O(N) scan needed).
 *
 * Rows younger than the grace window are left alone — a real in-flight save
 * may still be mid-protocol. The grace window is a SAFETY bound on worst-
 * case save latency; see DEFAULT_STALE_INTENT_GRACE_MS.
 *
 * Local DML only; no blob I/O. Safe to run on every open.
 */
export function drainStalePendingIntents(args: {
  readonly db: Database;
  readonly staleIntentGraceMs: number;
  readonly now: number;
}): void {
  const cutoff = args.now - args.staleIntentGraceMs;
  const stale = args.db
    .query("SELECT intent_id, hash FROM pending_blob_puts WHERE created_at <= ?")
    .all(cutoff) as ReadonlyArray<StaleIntentRow>;

  for (const row of stale) {
    // Short `BEGIN IMMEDIATE` tx per intent: we must read the artifacts
    // table AND either delete-only or delete+tombstone atomically, so a
    // concurrent save that inserts an artifacts row mid-check cannot trick
    // us into tombstoning a hash with a live reference.
    args.db.transaction(() => {
      const hasArtifact = args.db
        .query("SELECT 1 FROM artifacts WHERE content_hash = ? LIMIT 1")
        .get(row.hash);
      args.db.query("DELETE FROM pending_blob_puts WHERE intent_id = ?").run(row.intent_id);
      if (hasArtifact === null || hasArtifact === undefined) {
        // No live reference — enqueue a tombstone. INSERT OR IGNORE so a
        // pre-existing tombstone for the same hash (e.g., from a prior
        // delete) is preserved.
        args.db
          .query("INSERT OR IGNORE INTO pending_blob_deletes (hash, enqueued_at) VALUES (?, ?)")
          .run(row.hash, args.now);
      }
    })();
  }
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
    // Case A: intent never bound to a row (save crashed before metadata
    // tx). Resolution is now owned exclusively by drainStalePendingIntents
    // (spec §6.5 step 1). Younger-than-grace intents in this state might
    // belong to a real in-flight save that simply hasn't committed its
    // metadata row yet — do not touch them here; the background repair
    // worker will revisit after the grace window elapses.
    if (intent.artifact_id === null) continue;

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
