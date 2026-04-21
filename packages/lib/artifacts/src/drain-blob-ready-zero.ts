/**
 * `blob_ready = 0` repair drain — spec §6.5 step 4a.
 *
 * For each row with `blob_ready = 0`:
 *
 *   - `blobStore.has(hash)` is awaited OUTSIDE any DB lock. The snapshot of
 *     rows comes from a single SELECT at the top; per-row txs only span the
 *     subsequent UPDATE or DELETE+tombstone.
 *
 *   - **has() → true**: `UPDATE artifacts SET blob_ready = 1 WHERE id = ?
 *     AND blob_ready = 0`. The second predicate is the race guard: a
 *     concurrent `saveArtifact`'s own post-commit repair (spec §6.1 step 7)
 *     may have already flipped the row to 1 between our SELECT snapshot and
 *     this UPDATE. Matching zero rows is the correct outcome; it prevents
 *     counting the save's work as the worker's promotion. stats.promoted
 *     increments only on `changes > 0`.
 *
 *   - **has() → false** (blob definitively absent per the BlobStore
 *     read-after-write contract — §4): one `BEGIN IMMEDIATE` tx that bumps
 *     `repair_attempts` and reads back the new value. If the new value
 *     reaches `maxRepairAttempts` we stay inside the SAME transaction and
 *     terminal-resolve: DELETE the artifacts row + `INSERT OR IGNORE INTO
 *     pending_blob_deletes`. A crash between DELETE and INSERT is impossible
 *     because both are inside one tx — either both land or neither does,
 *     matching Plan 3's sweep Phase A atomicity guarantee.
 *
 *   - **has() throws** (transient — network timeout, 5xx, backend unreachable):
 *     leave the row untouched. Do NOT increment `repair_attempts`. A one-hour
 *     S3 outage across 10 retry passes must not erode the terminal-delete
 *     budget of a committed artifact whose blob is still intact on the
 *     backend. Count in `transientErrors` so the worker can surface outage
 *     rate.
 *
 * The BlobStore contract (§4) specifies read-after-write consistency for
 * `has()`: a `false` return is authoritative. ENOENT-style "blob not found"
 * is reported as `false`, never as a throw — so any thrown error here is by
 * definition a transient backend failure, not a definitive absence.
 */

import type { Database } from "bun:sqlite";
import type { BlobStore } from "@koi/blob-cas";
import { artifactId, sessionId } from "@koi/core";
import type { ArtifactStoreEvent } from "./types.js";

export interface DrainBlobReadyZeroArgs {
  readonly db: Database;
  readonly blobStore: BlobStore;
  readonly maxRepairAttempts: number;
  /**
   * Optional structured-event sink. Fires:
   *   - `repair_exhausted` on terminal-delete (budget met)
   *   - `transient_repair_error` when `blobStore.has` throws
   * Below-budget increments are intentionally silent. A callback that throws
   * is swallowed via console.warn so drain progress cannot be corrupted.
   */
  readonly onEvent?: (event: ArtifactStoreEvent) => void;
}

export interface DrainBlobReadyZeroStats {
  readonly promoted: number;
  readonly terminallyDeleted: number;
  readonly transientErrors: number;
}

interface BlobReadyZeroRow {
  readonly id: string;
  readonly content_hash: string;
  readonly repair_attempts: number;
  readonly session_id: string;
}

/**
 * Fire an event, isolating callback faults. A throwing consumer cannot
 * corrupt drain progress — we swallow + warn and carry on to the next row.
 * Kept private to this module: callers reach drift events via `onEvent`.
 */
function safeEmit(
  onEvent: ((event: ArtifactStoreEvent) => void) | undefined,
  event: ArtifactStoreEvent,
): void {
  if (onEvent === undefined) return;
  try {
    onEvent(event);
  } catch (err: unknown) {
    console.warn("[@koi/artifacts] onEvent callback threw; continuing drain", err);
  }
}

function promoteIfStillPending(db: Database, id: string): number {
  // `AND blob_ready = 0` guards against counting a concurrent save's own
  // repair (spec §6.1 step 7) as this worker's promotion. If the save
  // flipped the row to 1 between our SELECT snapshot and now, this UPDATE
  // matches zero rows — correct outcome, no double-promotion.
  const res = db
    .query("UPDATE artifacts SET blob_ready = 1 WHERE id = ? AND blob_ready = 0")
    .run(id);
  return res.changes;
}

interface BumpResult {
  readonly newAttempts: number;
  readonly terminallyDeleted: boolean;
}

function bumpAndMaybeTerminal(
  db: Database,
  id: string,
  hash: string,
  maxRepairAttempts: number,
): BumpResult {
  // One BEGIN IMMEDIATE tx. On terminal, DELETE and INSERT OR IGNORE INTO
  // pending_blob_deletes land atomically — same guarantee as Plan 3's
  // sweep Phase A (no crash window where the row is gone but the tombstone
  // is missing).
  const tx = db.transaction((): BumpResult => {
    db.query("UPDATE artifacts SET repair_attempts = repair_attempts + 1 WHERE id = ?").run(id);
    const row = db.query("SELECT repair_attempts FROM artifacts WHERE id = ?").get(id) as {
      readonly repair_attempts: number;
    } | null;
    const newAttempts = row?.repair_attempts ?? 0;
    if (newAttempts >= maxRepairAttempts) {
      db.query("DELETE FROM artifacts WHERE id = ?").run(id);
      db.query("INSERT OR IGNORE INTO pending_blob_deletes (hash, enqueued_at) VALUES (?, ?)").run(
        hash,
        Date.now(),
      );
      return { newAttempts, terminallyDeleted: true };
    }
    return { newAttempts, terminallyDeleted: false };
  });
  return tx();
}

export async function drainBlobReadyZero(
  args: DrainBlobReadyZeroArgs,
): Promise<DrainBlobReadyZeroStats> {
  // `session_id` rides along so `repair_exhausted` events can route drift
  // alerts by session. Cheap — the column is already indexed for quota.
  const rows = args.db
    .query(
      "SELECT id, content_hash, repair_attempts, session_id FROM artifacts WHERE blob_ready = 0",
    )
    .all() as ReadonlyArray<BlobReadyZeroRow>;

  // Running tallies. `let` is justified: we accumulate per-row outcomes.
  let promoted = 0;
  let terminallyDeleted = 0;
  let transientErrors = 0;

  for (const row of rows) {
    // has() outside the DB lock — per-row tx is opened only after we have a
    // definitive answer. A throw here is transient by contract; false is a
    // real absence (read-after-write).
    let present: boolean;
    try {
      present = await args.blobStore.has(row.content_hash);
    } catch (err: unknown) {
      // Transient backend failure. Row untouched; repair_attempts not bumped.
      transientErrors++;
      safeEmit(args.onEvent, {
        kind: "transient_repair_error",
        artifactId: artifactId(row.id),
        contentHash: row.content_hash,
        error: err,
      });
      continue;
    }

    if (present) {
      const changes = promoteIfStillPending(args.db, row.id);
      if (changes > 0) promoted++;
      continue;
    }

    const outcome = bumpAndMaybeTerminal(args.db, row.id, row.content_hash, args.maxRepairAttempts);
    if (outcome.terminallyDeleted) {
      terminallyDeleted++;
      safeEmit(args.onEvent, {
        kind: "repair_exhausted",
        artifactId: artifactId(row.id),
        contentHash: row.content_hash,
        sessionId: sessionId(row.session_id),
        attempts: outcome.newAttempts,
      });
    }
  }

  return { promoted, terminallyDeleted, transientErrors };
}
