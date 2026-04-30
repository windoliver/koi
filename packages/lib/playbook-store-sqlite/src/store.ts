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
        JSON.stringify(pb.tags),
        pb.confidence,
        pb.source,
        pb.createdAt,
        pb.updatedAt,
        pb.sessionCount,
        pb.version,
        pb.provenance !== undefined ? JSON.stringify(pb.provenance) : null,
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
  const selectById = db.query("SELECT * FROM structured_playbooks WHERE id = ?");
  const selectAll = db.query("SELECT * FROM structured_playbooks");
  const deleteCurrent = db.prepare("DELETE FROM structured_playbooks WHERE id = ?");
  const deleteLineage = db.prepare(
    "DELETE FROM structured_playbook_versions WHERE playbook_id = ?",
  );

  const save = async (pb: StructuredPlaybook): Promise<void> => {
    const snapshot = JSON.stringify(pb);
    const existing = selectVersion.get(pb.id, pb.version) as { readonly snapshot: string } | null;
    if (existing !== null) {
      if (existing.snapshot !== snapshot) {
        throw new Error(
          `playbook ${pb.id} version ${String(pb.version)} already committed with different content`,
        );
      }
      return;
    }
    db.transaction(() => {
      upsertCurrent.run(
        pb.id,
        pb.title,
        JSON.stringify(pb.sections),
        JSON.stringify(pb.tags),
        pb.source,
        pb.createdAt,
        pb.updatedAt,
        pb.sessionCount,
        pb.lastReflectedStepIndex ?? null,
        pb.version,
        pb.provenance !== undefined ? JSON.stringify(pb.provenance) : null,
      );
      insertVersion.run(pb.id, pb.version, snapshot, pb.updatedAt);
    })();
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
  const insert = db.prepare(`
    INSERT OR REPLACE INTO trajectory_entries
      (session_id, turn_index, timestamp, kind, identifier, outcome, duration_ms, metadata, bullet_ids)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
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
          insert.run(
            sessionId,
            e.turnIndex,
            e.timestamp,
            e.kind,
            e.identifier,
            e.outcome,
            e.durationMs,
            e.metadata !== undefined ? JSON.stringify(e.metadata) : null,
            e.bulletIds !== undefined ? JSON.stringify(e.bulletIds) : null,
          );
        }
      })();
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
  const insertProposal = db.prepare(`
    INSERT OR REPLACE INTO playbook_proposals
      (id, playbook_id, base_version, operations, source_trajectory_range, reflection, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertEval = db.prepare(`
    INSERT OR REPLACE INTO playbook_evaluations
      (id, proposal_id, verdict, metrics, notes, evaluated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const selectProposal = db.query("SELECT * FROM playbook_proposals WHERE id = ?");
  const selectByPlaybook = db.query(
    "SELECT * FROM playbook_proposals WHERE playbook_id = ? ORDER BY created_at, id",
  );

  return {
    recordProposal: async (p) => {
      insertProposal.run(
        p.id,
        p.playbookId,
        p.baseVersion,
        JSON.stringify(p.operations),
        JSON.stringify(p.sourceTrajectoryRange),
        JSON.stringify(p.reflection),
        p.createdAt,
      );
    },
    recordEvaluation: async (e) => {
      insertEval.run(
        e.id,
        e.proposalId,
        e.verdict,
        JSON.stringify(e.metrics),
        e.notes ?? null,
        e.evaluatedAt,
      );
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
