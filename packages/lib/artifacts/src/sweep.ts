/**
 * Phase A `sweepArtifacts()` — spec §6.3.
 *
 * Single `BEGIN IMMEDIATE` transaction. Metadata only — NO blob I/O. Computes
 * the deletion set from the store's configured lifecycle policy, deletes the
 * rows (`ON DELETE CASCADE` drops share grants), and tombstones any
 * `content_hash` whose only references were inside the deletion set.
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
 * Phase B (blob-on-disk reclamation via the tombstone journal) is Task 6.
 * This task returns `bytesReclaimed` as the sum of the deleted rows' `size`
 * columns — the metadata-level reclaim. Actual on-disk byte accounting
 * happens after Phase B deletes the blobs.
 */

import type { Database } from "bun:sqlite";
import type { LifecyclePolicy } from "./types.js";

export interface SweepResult {
  readonly deleted: number;
  readonly bytesReclaimed: number;
}

interface CandidateRow {
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

function selectTtlExpired(db: Database, now: number): ReadonlyArray<CandidateRow> {
  return db
    .query(
      `SELECT id, content_hash, size FROM artifacts
        WHERE blob_ready = 1
          AND expires_at IS NOT NULL
          AND expires_at < ?`,
    )
    .all(now) as ReadonlyArray<CandidateRow>;
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
  readonly policy?: LifecyclePolicy;
}): () => Promise<SweepResult> {
  const policy = args.policy;
  const ttlMs = policy?.ttlMs;
  const maxSessionBytes = policy?.maxSessionBytes;
  const maxVersionsPerName = policy?.maxVersionsPerName;

  return async () => {
    // Fast exit if no policy configured — a sweep with nothing to do must
    // not take the write lock or journal any side effects.
    if (ttlMs === undefined && maxSessionBytes === undefined && maxVersionsPerName === undefined) {
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

      if (deletionById.size === 0) {
        return { deleted: 0, bytesReclaimed: 0 };
      }

      // Compute candidateHashes INSIDE the tx — no TOCTOU against concurrent
      // saves. A hash that is still referenced outside the deletion set (by
      // any surviving artifacts row or any pending_blob_puts intent) is NOT
      // a candidate; its blob must survive.
      const deletionIds: ReadonlySet<string> = new Set(deletionById.keys());
      const candidateHashes = new Set<string>();
      const distinctHashes = new Set(Array.from(deletionById.values(), (r) => r.content_hash));
      for (const hash of distinctHashes) {
        if (!hashStillReferenced(args.db, hash, deletionIds)) {
          candidateHashes.add(hash);
        }
      }

      // DELETE rows. ON DELETE CASCADE removes share grants.
      const ids = Array.from(deletionIds);
      const placeholders = ids.map(() => "?").join(",");
      args.db.query(`DELETE FROM artifacts WHERE id IN (${placeholders})`).run(...ids);

      // Tombstone unreferenced hashes. ON CONFLICT DO NOTHING preserves the
      // uniqueness invariant for repeated sweeps.
      const tombstoneStmt = args.db.query(
        "INSERT INTO pending_blob_deletes (hash, enqueued_at) VALUES (?, ?) ON CONFLICT DO NOTHING",
      );
      for (const hash of candidateHashes) {
        tombstoneStmt.run(hash, now);
      }

      let bytesReclaimed = 0;
      for (const row of deletionById.values()) bytesReclaimed += row.size;

      return { deleted: deletionById.size, bytesReclaimed };
    });

    return tx();
  };
}
