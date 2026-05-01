/**
 * SQLite-backed implementation of @koi/ace-types stores.
 *
 * Single Database is shared across the four substores. Schema lives in
 * schema.ts; this file holds the factory wiring + row mappers.
 */

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  Playbook,
  PlaybookEvaluation,
  PlaybookProposal,
  PlaybookProposalStore,
  PlaybookProvenance,
  PlaybookSection,
  PlaybookStore,
  StructuredPlaybook,
  StructuredPlaybookStore,
  TrajectoryEntry,
  TrajectoryStore,
} from "@koi/ace-types";
import type { JsonObject } from "@koi/core/common";

import { applyPragmas, applySchema } from "./schema.js";

/**
 * Canonical JSON: stringify with deterministically-sorted object keys at every
 * depth. Lets idempotency checks compare stored vs. incoming payloads
 * semantically instead of by raw key insertion order. Arrays preserve order
 * (their order is meaningful in this domain — operations, sections, bullets).
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    const obj = v as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      sorted[k] = obj[k];
    }
    return sorted;
  });
}

/**
 * Compare two JSON-encoded strings (or nulls) for semantic equality. Re-parses
 * and canonicalizes both sides, so legacy rows written with `JSON.stringify`
 * and new rows written with `canonicalJson` compare equal when their parsed
 * structures match. Critical for upgrade safety: an idempotent retry after
 * deploy must not fail because the historical row was written under the old
 * non-canonical encoding.
 */
/**
 * Strip `provenance.committedAt` from a canonicalized snapshot string so two
 * idempotent retries compare equal even when the second retry will be
 * normalized to a different server commit time. Returns the input unchanged
 * if it doesn't contain a provenance object.
 */
function stripProvenanceTime(snapshotJson: string): string {
  try {
    const parsed = JSON.parse(snapshotJson) as { provenance?: { committedAt?: number } };
    if (parsed.provenance !== undefined) {
      const { committedAt: _ignored, ...rest } = parsed.provenance;
      // If `committedAt` was the only populated field, drop the provenance
      // key entirely so a retry whose provenance is just a timestamp compares
      // equal to a stored row with no provenance.
      if (Object.keys(rest).length === 0) {
        const { provenance: _p, ...withoutProv } = parsed;
        return canonicalJson(withoutProv);
      }
      return canonicalJson({ ...parsed, provenance: rest });
    }
    return canonicalJson(parsed);
  } catch {
    return snapshotJson;
  }
}

function jsonEqual(a: string | null, b: string | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  try {
    return canonicalJson(JSON.parse(a) as unknown) === canonicalJson(JSON.parse(b) as unknown);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SqlitePlaybookStoreConfig {
  /** Database path. Defaults to `~/.koi/ace.sqlite`. Use `:memory:` for tests. */
  readonly path?: string;
  /** "process" survives SIGKILL; "os" survives power loss. Default: "process". */
  readonly durability?: "process" | "os";
}

export interface SqlitePlaybookStore {
  readonly playbooks: PlaybookStore;
  readonly structuredPlaybooks: Required<
    Pick<StructuredPlaybookStore, "get" | "list" | "save" | "remove" | "getVersion">
  >;
  readonly trajectories: TrajectoryStore;
  readonly proposals: PlaybookProposalStore;
  readonly close: () => void;
}

export function createSqlitePlaybookStore(
  config: SqlitePlaybookStoreConfig = {},
): SqlitePlaybookStore {
  const path = config.path ?? join(homedir(), ".koi", "ace.sqlite");
  const db = new Database(path, { create: true });
  applyPragmas(db, config.durability ?? "process");
  applySchema(db);

  return {
    playbooks: createPlaybookStore(db),
    structuredPlaybooks: createStructuredPlaybookStore(db),
    trajectories: createTrajectoryStore(db),
    proposals: createProposalStore(db),
    close: () => db.close(),
  };
}

// ---------------------------------------------------------------------------
// PlaybookStore
// ---------------------------------------------------------------------------

interface PlaybookRow {
  readonly id: string;
  readonly title: string;
  readonly strategy: string;
  readonly tags: string;
  readonly confidence: number;
  readonly source: string;
  readonly created_at: number;
  readonly updated_at: number;
  readonly session_count: number;
  readonly version: number;
  readonly provenance: string | null;
}

function createPlaybookStore(db: Database): PlaybookStore {
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO playbooks
      (id, title, strategy, tags, confidence, source, created_at, updated_at, session_count, version, provenance)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectById = db.query("SELECT * FROM playbooks WHERE id = ?");
  const selectAll = db.query("SELECT * FROM playbooks");
  const selectByMinConfidence = db.query("SELECT * FROM playbooks WHERE confidence >= ?");
  const deleteById = db.prepare("DELETE FROM playbooks WHERE id = ?");

  return {
    save: async (pb) => {
      upsert.run(
        pb.id,
        pb.title,
        pb.strategy,
        canonicalJson(pb.tags),
        pb.confidence,
        pb.source,
        pb.createdAt,
        pb.updatedAt,
        pb.sessionCount,
        pb.version,
        pb.provenance !== undefined ? canonicalJson(pb.provenance) : null,
      );
    },
    get: async (id) => {
      const row = selectById.get(id) as PlaybookRow | null;
      return row !== null ? rowToPlaybook(row) : undefined;
    },
    list: async (options) => {
      const minConfidence = options?.minConfidence;
      const rows = (
        minConfidence !== undefined
          ? (selectByMinConfidence.all(minConfidence) as readonly PlaybookRow[])
          : (selectAll.all() as readonly PlaybookRow[])
      ).map(rowToPlaybook);
      return filterByTags(rows, options?.tags);
    },
    remove: async (id) => {
      const result = deleteById.run(id);
      return result.changes > 0;
    },
  };
}

function rowToPlaybook(row: PlaybookRow): Playbook {
  const base: Playbook = {
    id: row.id,
    title: row.title,
    strategy: row.strategy,
    tags: JSON.parse(row.tags) as readonly string[],
    confidence: row.confidence,
    source: row.source as Playbook["source"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sessionCount: row.session_count,
    version: row.version,
  };
  return row.provenance !== null
    ? { ...base, provenance: JSON.parse(row.provenance) as PlaybookProvenance }
    : base;
}

// ---------------------------------------------------------------------------
// StructuredPlaybookStore + lineage
// ---------------------------------------------------------------------------

interface StructuredPlaybookRow {
  readonly id: string;
  readonly title: string;
  readonly sections: string;
  readonly tags: string;
  readonly source: string;
  readonly created_at: number;
  readonly updated_at: number;
  readonly session_count: number;
  readonly last_reflected_step_index: number | null;
  readonly version: number;
  readonly provenance: string | null;
}

function createStructuredPlaybookStore(db: Database): SqlitePlaybookStore["structuredPlaybooks"] {
  const upsertCurrent = db.prepare(`
    INSERT OR REPLACE INTO structured_playbooks
      (id, title, sections, tags, source, created_at, updated_at, session_count,
       last_reflected_step_index, version, provenance)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertVersion = db.prepare(`
    INSERT INTO structured_playbook_versions (playbook_id, version, snapshot, committed_at)
    VALUES (?, ?, ?, ?)
  `);
  const selectVersion = db.query(
    "SELECT snapshot FROM structured_playbook_versions WHERE playbook_id = ? AND version = ?",
  );
  const selectCurrentVersion = db.query("SELECT version FROM structured_playbooks WHERE id = ?");
  const selectById = db.query("SELECT * FROM structured_playbooks WHERE id = ?");
  const selectAll = db.query("SELECT * FROM structured_playbooks");
  const selectWatermark = db.query(
    "SELECT last_reflected_step_index FROM structured_playbooks WHERE id = ?",
  );
  const deleteCurrent = db.prepare("DELETE FROM structured_playbooks WHERE id = ?");
  const deleteLineage = db.prepare(
    "DELETE FROM structured_playbook_versions WHERE playbook_id = ?",
  );

  const save = async (pb: StructuredPlaybook): Promise<void> => {
    // .immediate() acquires the SQLite RESERVED lock at BEGIN, so concurrent
    // identical retriers serialize cleanly instead of racing read snapshots
    // and tripping the version check on a stale view.
    db.transaction(() => {
      // Order matters: reject any below-head replay BEFORE the idempotency
      // short-circuit, otherwise a stale worker that retries an old version
      // resolves silently after head has advanced — losing the race without
      // surfacing it to the caller.
      const current = selectCurrentVersion.get(pb.id) as { readonly version: number } | null;
      if (current !== null && pb.version < current.version) {
        throw new Error(
          `playbook ${pb.id} cannot save version ${String(pb.version)} below current version ${String(current.version)}`,
        );
      }
      // Stamp the lineage commit time AFTER the write lock is held so the
      // audit trail reflects the actual commit moment, not the request
      // arrival moment. Overwrite any caller-supplied provenance.committedAt
      // with the same server time so the snapshot, the current row, and the
      // lineage table cannot diverge on the commit timestamp for one version.
      const committedAt = Date.now();
      const normalizedProvenance =
        pb.provenance !== undefined ? { ...pb.provenance, committedAt } : undefined;
      // Watermark monotonicity: a rollback re-saves an older snapshot, but
      // its `lastReflectedStepIndex` was captured before later reflection
      // ran. Clamping to max(current, incoming) prevents reopening already-
      // processed trajectory windows after a rollback.
      const currentWatermarkRow = selectWatermark.get(pb.id) as {
        readonly last_reflected_step_index: number | null;
      } | null;
      const currentWatermark = currentWatermarkRow?.last_reflected_step_index ?? null;
      const incomingWatermark = pb.lastReflectedStepIndex ?? null;
      const monotonicWatermark =
        currentWatermark === null
          ? incomingWatermark
          : incomingWatermark === null
            ? currentWatermark
            : Math.max(currentWatermark, incomingWatermark);
      const { lastReflectedStepIndex: _w, provenance: _p, ...rest } = pb;
      const normalized: StructuredPlaybook = {
        ...rest,
        ...(monotonicWatermark !== null ? { lastReflectedStepIndex: monotonicWatermark } : {}),
        ...(normalizedProvenance !== undefined ? { provenance: normalizedProvenance } : {}),
      };
      const snapshot = canonicalJson(normalized);
      const existing = selectVersion.get(pb.id, pb.version) as { readonly snapshot: string } | null;
      if (existing !== null) {
        // Idempotent retry only when the snapshot is semantically equal AND
        // it targets the current head. Re-canonicalize stored vs incoming so
        // legacy non-canonical rows still match. Comparison ignores
        // provenance.committedAt (which is normalized to server time on every
        // write) by stripping it from both sides before comparing.
        if (!jsonEqual(stripProvenanceTime(existing.snapshot), stripProvenanceTime(snapshot))) {
          throw new Error(
            `playbook ${pb.id} version ${String(pb.version)} already committed with different content`,
          );
        }
        // Self-heal: if lineage is intact but the head row is missing or
        // points at a different version (manual repair, partial-failure
        // crash), rebuild it from the canonical snapshot. Otherwise an
        // idempotent retry would silently report success while `get(id)`
        // still returned undefined or stale state.
        if (current === null || current.version !== pb.version) {
          upsertCurrent.run(
            pb.id,
            pb.title,
            canonicalJson(pb.sections),
            canonicalJson(pb.tags),
            pb.source,
            pb.createdAt,
            pb.updatedAt,
            pb.sessionCount,
            monotonicWatermark,
            pb.version,
            normalizedProvenance !== undefined ? canonicalJson(normalizedProvenance) : null,
          );
        }
        return;
      }
      upsertCurrent.run(
        pb.id,
        pb.title,
        canonicalJson(pb.sections),
        canonicalJson(pb.tags),
        pb.source,
        pb.createdAt,
        pb.updatedAt,
        pb.sessionCount,
        monotonicWatermark,
        pb.version,
        normalizedProvenance !== undefined ? canonicalJson(normalizedProvenance) : null,
      );
      insertVersion.run(pb.id, pb.version, snapshot, committedAt);
    }).immediate();
  };

  return {
    save,
    get: async (id) => {
      const row = selectById.get(id) as StructuredPlaybookRow | null;
      return row !== null ? rowToStructuredPlaybook(row) : undefined;
    },
    list: async (options) => {
      const rows = (selectAll.all() as readonly StructuredPlaybookRow[]).map(
        rowToStructuredPlaybook,
      );
      return filterByTags(rows, options?.tags);
    },
    remove: async (id) => {
      const result = db.transaction(() => {
        const r = deleteCurrent.run(id);
        deleteLineage.run(id);
        return r.changes > 0;
      })();
      return result;
    },
    getVersion: async (id, version) => {
      const row = selectVersion.get(id, version) as { readonly snapshot: string } | null;
      return row !== null ? (JSON.parse(row.snapshot) as StructuredPlaybook) : undefined;
    },
  };
}

function rowToStructuredPlaybook(row: StructuredPlaybookRow): StructuredPlaybook {
  const base = {
    id: row.id,
    title: row.title,
    sections: JSON.parse(row.sections) as readonly PlaybookSection[],
    tags: JSON.parse(row.tags) as readonly string[],
    source: row.source as StructuredPlaybook["source"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sessionCount: row.session_count,
    version: row.version,
  } satisfies Omit<StructuredPlaybook, "lastReflectedStepIndex" | "provenance">;
  const withWatermark =
    row.last_reflected_step_index !== null
      ? { ...base, lastReflectedStepIndex: row.last_reflected_step_index }
      : base;
  return row.provenance !== null
    ? { ...withWatermark, provenance: JSON.parse(row.provenance) as PlaybookProvenance }
    : withWatermark;
}

// ---------------------------------------------------------------------------
// TrajectoryStore
// ---------------------------------------------------------------------------

interface TrajectoryRow {
  readonly session_id: string;
  readonly turn_index: number;
  readonly timestamp: number;
  readonly kind: string;
  readonly identifier: string;
  readonly outcome: string;
  readonly duration_ms: number;
  readonly metadata: string | null;
  readonly bullet_ids: string | null;
}

function createTrajectoryStore(db: Database): TrajectoryStore {
  // Trajectories are append-only evidence with one explicit allowance:
  // late enrichment of `metadata` / `bulletIds` from null to a value is
  // permitted via UPDATE. Any other content drift on a duplicate key
  // (different timestamp/outcome/duration, or rewriting an already-set
  // metadata field) is rejected so replays cannot tamper with history.
  const insert = db.prepare(`
    INSERT INTO trajectory_entries
      (session_id, turn_index, timestamp, kind, identifier, outcome, duration_ms, metadata, bullet_ids)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, turn_index, identifier) DO NOTHING
  `);
  const selectExisting = db.query(
    "SELECT timestamp, kind, outcome, duration_ms, metadata, bullet_ids FROM trajectory_entries WHERE session_id = ? AND turn_index = ? AND identifier = ?",
  );
  // Compare-and-swap: only enrich when both fields are still NULL OR already
  // equal to the value being written. Defense in depth on top of .immediate()
  // — if any path were ever to bypass the write lock, this prevents a stale
  // overwrite from silently winning.
  const enrichExisting = db.prepare(
    `UPDATE trajectory_entries
        SET metadata = ?, bullet_ids = ?
      WHERE session_id = ? AND turn_index = ? AND identifier = ?
        AND (metadata IS NULL OR metadata = ?)
        AND (bullet_ids IS NULL OR bullet_ids = ?)`,
  );
  const selectSession = db.query(
    "SELECT * FROM trajectory_entries WHERE session_id = ? ORDER BY turn_index, identifier",
  );
  const selectSessions = db.query(
    "SELECT DISTINCT session_id FROM trajectory_entries ORDER BY session_id LIMIT ?",
  );

  return {
    append: async (sessionId, entries) => {
      db.transaction(() => {
        for (const e of entries) {
          const meta = e.metadata !== undefined ? canonicalJson(e.metadata) : null;
          const bullets = e.bulletIds !== undefined ? canonicalJson(e.bulletIds) : null;
          const result = insert.run(
            sessionId,
            e.turnIndex,
            e.timestamp,
            e.kind,
            e.identifier,
            e.outcome,
            e.durationMs,
            meta,
            bullets,
          );
          if (result.changes === 0) {
            // Row already existed. Idempotent if immutable fields match;
            // metadata / bullet_ids may be enriched once from null to a
            // value, but never overwritten or downgraded.
            const existing = selectExisting.get(sessionId, e.turnIndex, e.identifier) as {
              readonly timestamp: number;
              readonly kind: string;
              readonly outcome: string;
              readonly duration_ms: number;
              readonly metadata: string | null;
              readonly bullet_ids: string | null;
            } | null;
            if (existing === null) {
              throw new Error(
                `trajectory entry (${sessionId}, ${String(e.turnIndex)}, ${e.identifier}) conflict but row missing`,
              );
            }
            const immutableMatches =
              existing.timestamp === e.timestamp &&
              existing.kind === e.kind &&
              existing.outcome === e.outcome &&
              existing.duration_ms === e.durationMs;
            // Compare metadata/bullets semantically (canonical re-parse) so
            // legacy non-canonical rows still match a canonical retry.
            const metaCompatible =
              jsonEqual(existing.metadata, meta) || existing.metadata === null || meta === null;
            const bulletsCompatible =
              jsonEqual(existing.bullet_ids, bullets) ||
              existing.bullet_ids === null ||
              bullets === null;
            if (!immutableMatches || !metaCompatible || !bulletsCompatible) {
              throw new Error(
                `trajectory entry (${sessionId}, ${String(e.turnIndex)}, ${e.identifier}) already recorded with different content`,
              );
            }
            const nextMeta = existing.metadata ?? meta;
            const nextBullets = existing.bullet_ids ?? bullets;
            if (nextMeta !== existing.metadata || nextBullets !== existing.bullet_ids) {
              const enrich = enrichExisting.run(
                nextMeta,
                nextBullets,
                sessionId,
                e.turnIndex,
                e.identifier,
                nextMeta,
                nextBullets,
              );
              if (enrich.changes === 0) {
                throw new Error(
                  `trajectory entry (${sessionId}, ${String(e.turnIndex)}, ${e.identifier}) raced with another writer; enrichment rejected`,
                );
              }
            }
          }
        }
      }).immediate();
    },
    getSession: async (sessionId) => {
      const rows = selectSession.all(sessionId) as readonly TrajectoryRow[];
      return rows.map(rowToTrajectoryEntry);
    },
    listSessions: async (options) => {
      const limit = options?.limit ?? 1_000_000;
      const rows = selectSessions.all(limit) as readonly { readonly session_id: string }[];
      return rows.map((r) => r.session_id);
    },
  };
}

function rowToTrajectoryEntry(row: TrajectoryRow): TrajectoryEntry {
  const base = {
    turnIndex: row.turn_index,
    timestamp: row.timestamp,
    kind: row.kind as TrajectoryEntry["kind"],
    identifier: row.identifier,
    outcome: row.outcome as TrajectoryEntry["outcome"],
    durationMs: row.duration_ms,
  };
  const withMeta =
    row.metadata !== null ? { ...base, metadata: JSON.parse(row.metadata) as JsonObject } : base;
  return row.bullet_ids !== null
    ? { ...withMeta, bulletIds: JSON.parse(row.bullet_ids) as readonly string[] }
    : withMeta;
}

// ---------------------------------------------------------------------------
// PlaybookProposalStore
// ---------------------------------------------------------------------------

interface ProposalRow {
  readonly id: string;
  readonly playbook_id: string;
  readonly base_version: number;
  readonly operations: string;
  readonly source_trajectory_range: string;
  readonly reflection: string;
  readonly created_at: number;
}

function createProposalStore(db: Database): PlaybookProposalStore {
  // Proposals + evaluations are the immutable lineage the promotion gate
  // audits. ON CONFLICT DO NOTHING + a same-transaction content compare
  // makes the insert-and-compare path atomic across concurrent retriers:
  // the loser of an insert race re-reads the committed row and accepts the
  // write iff its payload is byte-identical.
  const insertProposal = db.prepare(`
    INSERT INTO playbook_proposals
      (id, playbook_id, base_version, operations, source_trajectory_range, reflection, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `);
  const insertEval = db.prepare(`
    INSERT INTO playbook_evaluations
      (id, proposal_id, verdict, metrics, notes, evaluated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `);
  const selectProposal = db.query("SELECT * FROM playbook_proposals WHERE id = ?");
  const selectProposalRaw = db.query(
    "SELECT operations, source_trajectory_range, reflection, playbook_id, base_version, created_at FROM playbook_proposals WHERE id = ?",
  );
  const selectEvalRaw = db.query(
    "SELECT verdict, metrics, notes, proposal_id, evaluated_at FROM playbook_evaluations WHERE id = ?",
  );
  const selectByPlaybook = db.query(
    "SELECT * FROM playbook_proposals WHERE playbook_id = ? ORDER BY created_at, id",
  );

  return {
    recordProposal: async (p) => {
      const ops = canonicalJson(p.operations);
      const range = canonicalJson(p.sourceTrajectoryRange);
      const reflection = canonicalJson(p.reflection);
      db.transaction(() => {
        const result = insertProposal.run(
          p.id,
          p.playbookId,
          p.baseVersion,
          ops,
          range,
          reflection,
          p.createdAt,
        );
        if (result.changes === 0) {
          const existing = selectProposalRaw.get(p.id) as {
            readonly operations: string;
            readonly source_trajectory_range: string;
            readonly reflection: string;
            readonly playbook_id: string;
            readonly base_version: number;
            readonly created_at: number;
          } | null;
          const same =
            existing !== null &&
            existing.playbook_id === p.playbookId &&
            existing.base_version === p.baseVersion &&
            existing.created_at === p.createdAt &&
            jsonEqual(existing.operations, ops) &&
            jsonEqual(existing.source_trajectory_range, range) &&
            jsonEqual(existing.reflection, reflection);
          if (!same) {
            throw new Error(`proposal ${p.id} already recorded with different content`);
          }
        }
      })();
    },
    recordEvaluation: async (e) => {
      const metrics = canonicalJson(e.metrics);
      const notes = e.notes ?? null;
      db.transaction(() => {
        const result = insertEval.run(e.id, e.proposalId, e.verdict, metrics, notes, e.evaluatedAt);
        if (result.changes === 0) {
          const existing = selectEvalRaw.get(e.id) as {
            readonly verdict: string;
            readonly metrics: string;
            readonly notes: string | null;
            readonly proposal_id: string;
            readonly evaluated_at: number;
          } | null;
          const same =
            existing !== null &&
            existing.proposal_id === e.proposalId &&
            existing.verdict === e.verdict &&
            existing.evaluated_at === e.evaluatedAt &&
            jsonEqual(existing.metrics, metrics) &&
            existing.notes === notes;
          if (!same) {
            throw new Error(`evaluation ${e.id} already recorded with different content`);
          }
        }
      })();
    },
    getProposal: async (id) => {
      const row = selectProposal.get(id) as ProposalRow | null;
      return row !== null ? rowToProposal(row) : undefined;
    },
    listProposals: async (playbookId) => {
      const rows = selectByPlaybook.all(playbookId) as readonly ProposalRow[];
      return rows.map(rowToProposal);
    },
  };
}

function rowToProposal(row: ProposalRow): PlaybookProposal {
  return {
    id: row.id,
    playbookId: row.playbook_id,
    baseVersion: row.base_version,
    operations: JSON.parse(row.operations) as PlaybookProposal["operations"],
    sourceTrajectoryRange: JSON.parse(
      row.source_trajectory_range,
    ) as PlaybookProposal["sourceTrajectoryRange"],
    reflection: JSON.parse(row.reflection) as PlaybookProposal["reflection"],
    createdAt: row.created_at,
  };
}

// PlaybookEvaluation type-check: schema retains evaluation rows for audit.
// Currently no public reader; getEvaluation is intentionally not exposed
// until a downstream consumer needs it. The unused import keeps the type
// surface visible for future expansion.
type _EvaluationRetained = PlaybookEvaluation;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function filterByTags<T extends { readonly tags: readonly string[] }>(
  rows: readonly T[],
  tags: readonly string[] | undefined,
): readonly T[] {
  if (tags === undefined || tags.length === 0) return rows;
  return rows.filter((r) => tags.every((t) => r.tags.includes(t)));
}
