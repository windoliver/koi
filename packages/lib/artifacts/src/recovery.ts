/**
 * Plan 4 startup recovery — local DML only, zero blob I/O.
 *
 * Spec §6.5 Plan 4 contract: `createArtifactStore` must NEVER call
 * `blobStore.has()` / `put()` / `delete()` on the critical path. The
 * remaining synchronous recovery passes here operate only on already-
 * resolved rows/intents — the background worker (Plan 4 tasks 3-5)
 * handles every `blob_ready = 0` row that still requires a blob probe.
 *
 * Passes (ordered):
 *
 * 1. `drainStalePendingIntents` (Task 1) — rows in `pending_blob_puts`
 *    older than the grace window. Each is either deleted (artifacts row
 *    references the hash) or deleted + tombstoned (no live reference).
 *    Pure local DML.
 *
 * 2. `drainPendingIntents` — resolves only the two shapes that need no
 *    blob I/O to disambiguate:
 *      - `artifact_id` bound, target row externally deleted → retire
 *        intent + tombstone the hash if unreferenced.
 *      - `artifact_id` bound, target row already `blob_ready = 1` →
 *        retire the intent (save completed past its own UPDATE).
 *    `artifact_id IS NULL` entries inside the grace window and
 *    `blob_ready = 0` rows with a bound intent are LEFT ALONE — the
 *    worker revisits after the grace window and probes the backend.
 *
 * The old `drainOrphanedHiddenRows` pass is gone: rows that sit at
 * `blob_ready = 0` with no intent still require a backend probe to
 * distinguish "blob really exists, intent was lost" from "blob was
 * deleted, row must be tombstoned" — that probe is now the worker's job.
 *
 * Every read-side API already hides `blob_ready = 0` rows, so leaving
 * them untouched on open is safe: the store opens faster, no remote
 * blob call can block bootstrap, and no negative probe on a transient
 * backend outage can erode a committed save's retry budget.
 */

import type { Database } from "bun:sqlite";

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
}

export function runStartupRecovery(args: {
  readonly db: Database;
  readonly staleIntentGraceMs?: number;
}): void {
  const staleIntentGraceMs = args.staleIntentGraceMs ?? DEFAULT_STALE_INTENT_GRACE_MS;

  // Spec §6.5 step 1: convert stale pre-commit intents (older than the
  // grace window) directly into sweep tombstones (or drop them outright
  // when an artifacts row already references the hash). Local DML only.
  drainStalePendingIntents({
    db: args.db,
    staleIntentGraceMs,
    now: Date.now(),
  });

  // Pass 2: walk pending_blob_puts for intents bound to a specific row
  // that can be resolved without touching the backend. blob_ready=0
  // targets with a bound intent are left untouched — worker owns them.
  drainPendingIntents({ db: args.db });
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
 *     own repair path owns resolution; there is nothing for this step to
 *     reclaim.
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

/**
 * Resolve pending_blob_puts rows that can be cleaned up with no blob I/O:
 *
 *   - `artifact_id IS NULL` → owned exclusively by the stale-intent drain
 *     above (once the grace window elapses) or by the worker (before it).
 *     Not touched here.
 *   - `artifact_id` bound, target row missing → row was externally deleted
 *     after the intent was bound. Retire the intent + tombstone the hash
 *     if unreferenced.
 *   - `artifact_id` bound, target row `blob_ready = 1` → save completed
 *     past its UPDATE but before retiring the intent. Retire the intent.
 *   - `artifact_id` bound, target row `blob_ready = 0` → worker territory.
 *     The row is invisible via read-side APIs; the worker will probe
 *     `blobStore.has(hash)` asynchronously and promote or terminal-delete.
 *     Leave both the row and the intent untouched here.
 */
function drainPendingIntents(args: { readonly db: Database }): void {
  const intents = args.db
    .query("SELECT intent_id, hash, artifact_id FROM pending_blob_puts ORDER BY created_at")
    .all() as ReadonlyArray<IntentRow>;

  for (const intent of intents) {
    if (intent.artifact_id === null) continue;

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
    }
    // target.blob_ready === 0 → blob probe is the worker's responsibility.
    // The row is invisible to readers; leaving it untouched is safe.
  }
}
