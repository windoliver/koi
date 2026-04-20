/**
 * `sweepArtifacts()` — spec §6.3.
 *
 * Phase A: single `BEGIN IMMEDIATE` transaction. Metadata only — NO blob I/O.
 * Computes the deletion set from the store's configured lifecycle policy,
 * deletes the rows (`ON DELETE CASCADE` drops share grants), and tombstones
 * any `content_hash` whose only references were inside the deletion set.
 *
 * Scanning is restricted to `blob_ready = 1` rows. In-flight saves
 * (`blob_ready = 0`) are never candidates; they are reclaimed exclusively by
 * startup recovery (§6.5) if the save crashed.
 *
 * The "only references inside deletion set" check is the subtle part and
 * must run inside the same transaction as the DELETE to preclude TOCTOU:
 * a concurrent save that journaled an intent in `pending_blob_puts` or a
 * surviving artifacts row that still points at the same hash keeps the
 * blob alive — no tombstone.
 *
 * Phase B: drain tombstones from `pending_blob_deletes` via the three-tx
 * claim/delete/reconcile protocol. Blob I/O runs OUTSIDE any SQLite lock
 * so a remote backend can take arbitrary time without blocking saves. See
 * drain-tombstones.ts for the full protocol + resume-from-claimed rule.
 * Plan 4 moves Phase B to a background worker; until then Phase B runs
 * sequentially at the tail of every sweep call so a single public invocation
 * leaves the store in the expected clean state.
 *
 * `bytesReclaimed` is the sum of the deleted rows' `size` columns — the
 * metadata-level reclaim. Byte-level accounting for on-disk reclaim is not
 * returned here because Phase B may drain tombstones enqueued by prior
 * sweeps and sizes aren't journaled in the tombstone row.
 */

import type { Database } from "bun:sqlite";
import type { BlobStore } from "@koi/blob-cas";
import { createDrainTombstones } from "./drain-tombstones.js";
import type { LifecyclePolicy } from "./types.js";

export interface SweepResult {
  readonly deleted: number;
  readonly bytesReclaimed: number;
}

/**
 * A row slated for deletion by a sweep. Shared between the full-policy
 * `sweepArtifacts` (§6.3) and the open-path `sweepTtlOnOpen` (§6.5 step 3)
 * so both use the same candidate-hash logic and the same tombstone protocol.
 */
export interface CandidateRow {
  readonly id: string;
  readonly content_hash: string;
  readonly size: number;
}

interface QuotaRow {
  readonly id: string;
  readonly content_hash: string;
  readonly size: number;
  readonly session_id: string;
  readonly created_at: number;
}

interface RetentionRow {
  readonly id: string;
  readonly content_hash: string;
  readonly size: number;
  readonly session_id: string;
  readonly name: string;
  readonly version: number;
}

export function selectTtlExpired(db: Database, now: number): ReadonlyArray<CandidateRow> {
  return db
    .query(
      `SELECT id, content_hash, size FROM artifacts
        WHERE blob_ready = 1
          AND expires_at IS NOT NULL
          AND expires_at < ?`,
    )
    .all(now) as ReadonlyArray<CandidateRow>;
}

/**
 * Shared Phase A reap: DELETE rows + tombstone any content_hash whose only
 * references were inside the deletion set. Must be called inside a BEGIN
 * IMMEDIATE transaction so the candidate-hash check is free of TOCTOU
 * against concurrent saves (a save journaling an intent for the same hash
 * keeps the blob alive).
 *
 * Used by `sweepArtifacts` (full policy) and by `sweepTtlOnOpen` (TTL-only
 * on create-store). Returns a summary so callers can surface counters.
 */
export function reapDeletionSet(args: {
  readonly db: Database;
  readonly deletionById: ReadonlyMap<string, CandidateRow>;
  readonly now: number;
}): SweepResult {
  if (args.deletionById.size === 0) return { deleted: 0, bytesReclaimed: 0 };

  const deletionIds: ReadonlySet<string> = new Set(args.deletionById.keys());
  const candidateHashes = new Set<string>();
  const distinctHashes = new Set(Array.from(args.deletionById.values(), (r) => r.content_hash));
  for (const hash of distinctHashes) {
    if (!hashStillReferenced(args.db, hash, deletionIds)) {
      candidateHashes.add(hash);
    }
  }

  const ids = Array.from(deletionIds);
  // NOTE: `IN (?, ?, ...)` placeholder count must stay below SQLite's
  // SQLITE_MAX_VARIABLE_NUMBER (999 on conservative builds, 32766 on modern
  // builds). Current sweeps operate on O(100) rows per iteration so this is
  // fine. If sweep sizes grow, batch the DELETE or use
  // `WITH cte(id) AS (VALUES ...)` instead. Same constraint applies to the
  // sibling IN-clause in `hashStillReferenced`.
  const placeholders = ids.map(() => "?").join(",");
  args.db.query(`DELETE FROM artifacts WHERE id IN (${placeholders})`).run(...ids);

  const tombstoneStmt = args.db.query(
    "INSERT INTO pending_blob_deletes (hash, enqueued_at) VALUES (?, ?) ON CONFLICT DO NOTHING",
  );
  for (const hash of candidateHashes) {
    tombstoneStmt.run(hash, args.now);
  }

  let bytesReclaimed = 0;
  for (const row of args.deletionById.values()) bytesReclaimed += row.size;
  return { deleted: args.deletionById.size, bytesReclaimed };
}

function selectQuotaExcess(
  db: Database,
  maxBytes: number,
  excludedIds: ReadonlySet<string>,
): ReadonlyArray<CandidateRow> {
  const rows = db
    .query(
      `SELECT id, content_hash, size, session_id, created_at FROM artifacts
        WHERE blob_ready = 1
        ORDER BY session_id, created_at ASC, id ASC`,
    )
    .all() as ReadonlyArray<QuotaRow>;

  const bySession = new Map<string, Array<QuotaRow>>();
  for (const row of rows) {
    if (excludedIds.has(row.id)) continue;
    const arr = bySession.get(row.session_id) ?? [];
    arr.push(row);
    bySession.set(row.session_id, arr);
  }

  const out: Array<CandidateRow> = [];
  for (const arr of bySession.values()) {
    const total = arr.reduce((acc, r) => acc + r.size, 0);
    let remaining = total;
    for (const r of arr) {
      if (remaining <= maxBytes) break;
      out.push({ id: r.id, content_hash: r.content_hash, size: r.size });
      remaining -= r.size;
    }
  }
  return out;
}

function selectRetentionExcess(
  db: Database,
  maxVersions: number,
  excludedIds: ReadonlySet<string>,
): ReadonlyArray<CandidateRow> {
  const rows = db
    .query(
      `SELECT id, content_hash, size, session_id, name, version FROM artifacts
        WHERE blob_ready = 1
        ORDER BY session_id, name, version DESC`,
    )
    .all() as ReadonlyArray<RetentionRow>;

  const kept = new Map<string, number>();
  const out: Array<CandidateRow> = [];
  for (const row of rows) {
    if (excludedIds.has(row.id)) continue;
    const key = `${row.session_id}\u0000${row.name}`;
    const count = kept.get(key) ?? 0;
    if (count < maxVersions) {
      kept.set(key, count + 1);
      continue;
    }
    out.push({ id: row.id, content_hash: row.content_hash, size: row.size });
  }
  return out;
}

function hashStillReferenced(
  db: Database,
  hash: string,
  deletionIds: ReadonlySet<string>,
): boolean {
  // A surviving artifact row (any blob_ready state; blob_ready=0 in-flight
  // rows keep the blob alive too) outside the deletion set keeps the hash
  // alive. Likewise a pending_blob_puts intent — a save that put bytes but
  // hasn't yet INSERTed metadata.
  const ids: ReadonlyArray<string> = Array.from(deletionIds);
  if (ids.length === 0) {
    const aliveRow = db.query("SELECT 1 FROM artifacts WHERE content_hash = ? LIMIT 1").get(hash);
    if (aliveRow) return true;
  } else {
    const placeholders = ids.map(() => "?").join(",");
    const aliveRow = db
      .query(
        `SELECT 1 FROM artifacts WHERE content_hash = ? AND id NOT IN (${placeholders}) LIMIT 1`,
      )
      .get(hash, ...ids);
    if (aliveRow) return true;
  }

  const intent = db.query("SELECT 1 FROM pending_blob_puts WHERE hash = ? LIMIT 1").get(hash);
  return intent !== null;
}

export function createSweepArtifacts(args: {
  readonly db: Database;
  readonly blobStore: BlobStore;
  readonly policy?: LifecyclePolicy;
}): () => Promise<SweepResult> {
  const policy = args.policy;
  const ttlMs = policy?.ttlMs;
  const maxSessionBytes = policy?.maxSessionBytes;
  const maxVersionsPerName = policy?.maxVersionsPerName;
  const drainTombstones = createDrainTombstones({ db: args.db, blobStore: args.blobStore });

  return async () => {
    // Even when no policy is configured, Phase B must still drain tombstones
    // left by prior sweeps, explicit deletes (§6.6), or startup recovery
    // (§6.5). Phase A is the only no-op branch here.
    if (ttlMs === undefined && maxSessionBytes === undefined && maxVersionsPerName === undefined) {
      await drainTombstones();
      return { deleted: 0, bytesReclaimed: 0 };
    }

    const tx = args.db.transaction((): SweepResult => {
      const now = Date.now();
      const deletionById = new Map<string, CandidateRow>();

      // 1. TTL-expired (frozen per-row expires_at; not recomputed from policy).
      if (ttlMs !== undefined) {
        for (const row of selectTtlExpired(args.db, now)) {
          deletionById.set(row.id, row);
        }
      }

      // 2. Quota excess — oldest first per session, until under limit.
      //    Exclude rows already in the deletion set so we don't double-count.
      if (maxSessionBytes !== undefined) {
        const excluded = new Set(deletionById.keys());
        for (const row of selectQuotaExcess(args.db, maxSessionBytes, excluded)) {
          deletionById.set(row.id, row);
        }
      }

      // 3. Retention excess — oldest versions per (session, name) beyond N.
      if (maxVersionsPerName !== undefined) {
        const excluded = new Set(deletionById.keys());
        for (const row of selectRetentionExcess(args.db, maxVersionsPerName, excluded)) {
          deletionById.set(row.id, row);
        }
      }

      // Compute candidateHashes + DELETE + tombstone INSIDE the tx — no
      // TOCTOU against concurrent saves. A hash that is still referenced
      // outside the deletion set (by any surviving artifacts row or any
      // pending_blob_puts intent) is NOT a candidate; its blob must survive.
      // ON DELETE CASCADE removes share grants. ON CONFLICT DO NOTHING
      // preserves the uniqueness invariant for repeated sweeps.
      return reapDeletionSet({ db: args.db, deletionById, now });
    });

    const phaseA = tx();
    // Phase B: drain the tombstone journal with blob I/O outside any DB
    // lock. Runs on every sweep so callers don't have to wire up a separate
    // API; Plan 4 relocates this to a background worker.
    await drainTombstones();
    return phaseA;
  };
}

/**
 * Spec §6.5 step 3: TTL-only Phase A sweep executed synchronously on
 * `createArtifactStore`. A single `BEGIN IMMEDIATE` transaction that
 * tombstones rows whose per-row `expires_at` is already in the past.
 *
 * **Local SQLite DML only — no blob I/O, no network.** The tombstones it
 * enqueues are drained later by the background Phase B worker (Plan 4
 * Tasks 3-5). Used instead of a full `sweepArtifacts` so a stricter policy
 * or rollback cannot silently delete previously-valid artifacts at
 * startup: only TTL (frozen `expires_at` per row at save time) is safe to
 * apply unconditionally — quota and per-name retention are explicit
 * sweep-only decisions.
 *
 * `blob_ready = 0` rows are excluded by `selectTtlExpired`'s predicate so
 * an in-flight save's row (including one left mid-repair by a crash) is
 * never a candidate.
 */
export function sweepTtlOnOpen(args: { readonly db: Database; readonly now: number }): SweepResult {
  return args.db.transaction((): SweepResult => {
    const deletionById = new Map<string, CandidateRow>();
    for (const row of selectTtlExpired(args.db, args.now)) {
      deletionById.set(row.id, row);
    }
    return reapDeletionSet({ db: args.db, deletionById, now: args.now });
  })();
}
