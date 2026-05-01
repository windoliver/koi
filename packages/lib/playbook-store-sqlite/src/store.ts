/**
 * SQLite-backed implementation of @koi/ace-types stores.
 *
 * Single Database is shared across the four substores. Schema lives in
 * schema.ts; this file holds the factory wiring + row mappers.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

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
 * Strip server-normalized fields from a canonicalized snapshot so two
 * idempotent retries compare equal even after the server applies its
 * normalizations. Removes:
 *   - `provenance.committedAt` (server-stamped commit time)
 *   - `lastReflectedStepIndex` (server-clamped to max(current, incoming) for
 *     watermark monotonicity)
 * A caller cannot reproduce these server-controlled values on a retry, so
 * direct equality on the canonical snapshot would falsely report content
 * drift. Comparing the *caller-controlled* fields is the right invariant.
 */
function stripServerNormalizedFields(snapshotJson: string): string {
  try {
    const parsed = JSON.parse(snapshotJson) as {
      provenance?: { committedAt?: number };
      lastReflectedStepIndex?: number;
    };
    const { lastReflectedStepIndex: _w, ...withoutWatermark } = parsed;
    if (withoutWatermark.provenance !== undefined) {
      const { committedAt: _ignored, ...rest } = withoutWatermark.provenance;
      if (Object.keys(rest).length === 0) {
        const { provenance: _p, ...withoutProv } = withoutWatermark;
        return canonicalJson(withoutProv);
      }
      return canonicalJson({ ...withoutWatermark, provenance: rest });
    }
    return canonicalJson(withoutWatermark);
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
  /**
   * Database path. **Required** — there is no global default. The store keys
   * playbooks/trajectories/proposals only by their domain identifiers, with
   * no workspace or tenant column, so a shared default file would let learned
   * state from one project bleed into another. Callers must provide a path
   * scoped to the current workspace/repo (e.g. `<workspaceRoot>/.koi/ace.sqlite`)
   * or `:memory:` for tests.
   */
  readonly path: string;
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

export function createSqlitePlaybookStore(config: SqlitePlaybookStoreConfig): SqlitePlaybookStore {
  if (config.path.length === 0) {
    throw new Error("createSqlitePlaybookStore: config.path is required");
  }
  // Ensure the parent directory exists for non-memory paths so callers don't
  // have to mkdir before opening the store.
  if (config.path !== ":memory:") {
    mkdirSync(dirname(config.path), { recursive: true });
  }
  const db = new Database(config.path, { create: true });
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

  const selectFullById = db.query("SELECT * FROM playbooks WHERE id = ?");

  return {
    save: async (pb) => {
      // Compare-and-swap on version under concurrent writers:
      //   - version < current: stale save, reject.
      //   - version == current: must be byte-identical content (idempotent retry).
      //     Different content at the same version means two concurrent
      //     consolidators derived `prev.version + 1` from the same snapshot
      //     and produced divergent payloads. Accepting either silently loses
      //     the other's learned state — reject and force the caller to
      //     re-derive at version + 1.
      //   - version > current: accept (forward progress).
      // .immediate() acquires RESERVED lock at BEGIN so the read-then-write
      // is serialized against peer writers.
      const incomingTags = canonicalJson(pb.tags);
      const incomingProvenance = pb.provenance !== undefined ? canonicalJson(pb.provenance) : null;
      db.transaction(() => {
        const current = selectFullById.get(pb.id) as PlaybookRow | null;
        if (current !== null) {
          if (pb.version < current.version) {
            throw new Error(
              `playbook ${pb.id} cannot save version ${String(pb.version)} below current version ${String(current.version)}`,
            );
          }
          if (pb.version === current.version) {
            const sameContent =
              current.title === pb.title &&
              current.strategy === pb.strategy &&
              current.confidence === pb.confidence &&
              current.source === pb.source &&
              current.created_at === pb.createdAt &&
              current.updated_at === pb.updatedAt &&
              current.session_count === pb.sessionCount &&
              jsonEqual(current.tags, incomingTags) &&
              jsonEqual(current.provenance, incomingProvenance);
            if (!sameContent) {
              throw new Error(
                `playbook ${pb.id} version ${String(pb.version)} already committed with different content; re-derive at version ${String(pb.version + 1)}`,
              );
            }
            // Identical retry — no-op.
            return;
          }
        }
        upsert.run(
          pb.id,
          pb.title,
          pb.strategy,
          incomingTags,
          pb.confidence,
          pb.source,
          pb.createdAt,
          pb.updatedAt,
          pb.sessionCount,
          pb.version,
          incomingProvenance,
        );
      }).immediate();
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
  // Lineage truth: MAX(version) committed for this playbook. Used to compute
  // the effective head when the mutable head row is missing or stale. A
  // partial-failure crash can leave lineage with v5 but no head row; using
  // only the head row for the regression check would let a v3 retry sneak
  // back in as the visible head.
  const selectLineageMaxVersion = db.query(
    "SELECT MAX(version) AS v FROM structured_playbook_versions WHERE playbook_id = ?",
  );
  const selectById = db.query("SELECT * FROM structured_playbooks WHERE id = ?");
  const selectAll = db.query("SELECT * FROM structured_playbooks");
  const selectWatermark = db.query(
    "SELECT last_reflected_step_index FROM structured_playbooks WHERE id = ?",
  );
  // Watermark fallback when the head row is missing: read the latest
  // committed lineage snapshot and extract its lastReflectedStepIndex so a
  // forward save still clamps against the persisted watermark.
  const selectLatestLineageSnapshot = db.query(
    "SELECT snapshot FROM structured_playbook_versions WHERE playbook_id = ? ORDER BY version DESC LIMIT 1",
  );
  const deleteCurrent = db.prepare("DELETE FROM structured_playbooks WHERE id = ?");
  const deleteLineage = db.prepare(
    "DELETE FROM structured_playbook_versions WHERE playbook_id = ?",
  );
  const countDependentProposals = db.query(
    "SELECT COUNT(*) AS n FROM playbook_proposals WHERE playbook_id = ?",
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
      const lineageMaxRow = selectLineageMaxVersion.get(pb.id) as {
        readonly v: number | null;
      } | null;
      const lineageMax = lineageMaxRow?.v ?? null;
      // Effective head = current head row if present, else lineage MAX as
      // fallback when the head row is missing (e.g. fresh self-heal scenario).
      // We do NOT take max(current, lineageMax) for monotonic check: a stray
      // higher lineage row from manual repair or historical corruption must
      // not wedge healthy writes against the live head pointer.
      const effectiveHead = current?.version ?? lineageMax ?? null;
      if (effectiveHead !== null && pb.version < effectiveHead) {
        throw new Error(
          `playbook ${pb.id} cannot save version ${String(pb.version)} below current version ${String(effectiveHead)}`,
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
      // When the head row is missing, fall back to the latest lineage
      // snapshot's watermark. Otherwise a forward save after head loss
      // would clamp against null and silently downgrade the watermark,
      // reopening already-reflected trajectory windows.
      let currentWatermark: number | null;
      if (currentWatermarkRow !== null) {
        currentWatermark = currentWatermarkRow.last_reflected_step_index;
      } else {
        const latestRow = selectLatestLineageSnapshot.get(pb.id) as {
          readonly snapshot: string;
        } | null;
        if (latestRow !== null) {
          const latestSnapshot = JSON.parse(latestRow.snapshot) as {
            readonly lastReflectedStepIndex?: number;
          };
          currentWatermark = latestSnapshot.lastReflectedStepIndex ?? null;
        } else {
          currentWatermark = null;
        }
      }
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
        // Whether or not the head row is present, the caller payload at an
        // already-committed lineage version must be semantically equal to
        // the stored snapshot (modulo provenance.committedAt which is
        // normalized server-side). A divergent payload is rejected loudly
        // — silent self-heal on missing head with mismatched content would
        // be a lost-update bug.
        if (
          !jsonEqual(
            stripServerNormalizedFields(existing.snapshot),
            stripServerNormalizedFields(snapshot),
          )
        ) {
          throw new Error(
            `playbook ${pb.id} version ${String(pb.version)} already committed with different content`,
          );
        }
        // Self-heal when the head row is missing OR present at this
        // exact version (where it could be stale relative to canonical
        // lineage). Always rebuild from stored snapshot — UPSERT is a
        // no-op when the head already matches and a repair otherwise.
        // We do NOT rebuild when current exists at a DIFFERENT version —
        // that would silently fast-forward (or rewind) the monotonic head.
        if (current === null || current.version === pb.version) {
          const stored = JSON.parse(existing.snapshot) as StructuredPlaybook;
          upsertCurrent.run(
            stored.id,
            stored.title,
            canonicalJson(stored.sections),
            canonicalJson(stored.tags),
            stored.source,
            stored.createdAt,
            stored.updatedAt,
            stored.sessionCount,
            stored.lastReflectedStepIndex ?? null,
            stored.version,
            stored.provenance !== undefined ? canonicalJson(stored.provenance) : null,
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
      // Hard-delete: drop both the head row and all lineage rows in one
      // transaction. Matches the in-memory baseline contract (`data.delete`)
      // — callers expect remove() to actually remove.
      //
      // Dependent proposals block deletion: playbook_proposals has an
      // ON DELETE RESTRICT composite FK to structured_playbook_versions,
      // so removing a playbook with outstanding proposals would fail at
      // the SQL layer with a generic FK error. Detect and surface a
      // domain-typed error instead, so callers know to clean up the
      // proposal/evaluation flow first.
      //
      // .immediate() acquires the RESERVED write lock at BEGIN so the
      // dependency count + delete sequence is serialized against
      // concurrent proposal inserts on a shared file. Without this, a
      // peer writer could insert a proposal between our COUNT(*) returning
      // 0 and the DELETE, surfacing the raw FK constraint error.
      try {
        const result = db
          .transaction(() => {
            const dep = countDependentProposals.get(id) as { readonly n: number } | null;
            if (dep !== null && dep.n > 0) {
              throw new Error(
                `cannot remove structured playbook ${id}: ${String(dep.n)} dependent proposal(s) exist; remove proposals/evaluations first`,
              );
            }
            // Return true if EITHER head OR lineage was removed. Returning
            // false when only lineage rows existed (head missing, lineage
            // intact) would hide an irreversible destructive change behind
            // a "not found" result.
            const headDeleted = deleteCurrent.run(id);
            const lineageDeleted = deleteLineage.run(id);
            return headDeleted.changes > 0 || lineageDeleted.changes > 0;
          })
          .immediate();
        return result;
      } catch (err: unknown) {
        // Defensive remap: if SQLite still surfaces a FK error (e.g.
        // because some non-proposal table grew an unexpected dependency
        // on lineage), give callers the same domain-typed message instead
        // of leaking SQLITE_CONSTRAINT_FOREIGNKEY.
        const code =
          typeof err === "object" && err !== null && "code" in err
            ? (err as { readonly code?: unknown }).code
            : undefined;
        if (code === "SQLITE_CONSTRAINT_FOREIGNKEY") {
          throw new Error(
            `cannot remove structured playbook ${id}: dependent rows exist; remove proposals/evaluations first`,
          );
        }
        throw err;
      }
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
  // Trajectory rows are an append-only audit log keyed by per-session seq, a
  // monotonic counter assigned at append time. Multiple same-tool calls
  // within a single turn round-trip as distinct rows.
  //
  // Append is NOT idempotent: a legitimate second batch with identical
  // contents must persist as additional rows (e.g. the same fs.read sequence
  // genuinely repeated in a later turn block). Callers that need retry
  // dedup after an unknown-commit-state failure must coordinate that
  // themselves (idempotency token, caller-side log, etc.). Matches the
  // in-memory baseline `[...prev, ...entries]` semantics.
  const insert = db.prepare(`
    INSERT INTO trajectory_entries
      (session_id, seq, turn_index, timestamp, kind, identifier, outcome, duration_ms, metadata, bullet_ids)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectMaxSeq = db.query(
    "SELECT MAX(seq) AS s FROM trajectory_entries WHERE session_id = ?",
  );
  const selectSession = db.query(
    "SELECT * FROM trajectory_entries WHERE session_id = ? ORDER BY seq",
  );
  const selectSessions = db.query(
    "SELECT DISTINCT session_id FROM trajectory_entries ORDER BY session_id LIMIT ?",
  );

  return {
    append: async (sessionId, entries) => {
      if (entries.length === 0) return;
      // .immediate() acquires RESERVED at BEGIN so the MAX(seq) read and
      // ensuing inserts serialize against peer writers — concurrent appends
      // can't race on the seq counter.
      db.transaction(() => {
        const maxRow = selectMaxSeq.get(sessionId) as { readonly s: number | null } | null;
        let next = (maxRow?.s ?? 0) + 1;
        for (const e of entries) {
          const meta = e.metadata !== undefined ? canonicalJson(e.metadata) : null;
          const bullets = e.bulletIds !== undefined ? canonicalJson(e.bulletIds) : null;
          insert.run(
            sessionId,
            next,
            e.turnIndex,
            e.timestamp,
            e.kind,
            e.identifier,
            e.outcome,
            e.durationMs,
            meta,
            bullets,
          );
          next += 1;
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
  const selectStructuredHeadVersion = db.query(
    "SELECT version FROM structured_playbooks WHERE id = ?",
  );
  const selectStructuredLineageMaxVersion = db.query(
    "SELECT MAX(version) AS v FROM structured_playbook_versions WHERE playbook_id = ?",
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
        if (result.changes > 0) {
          // baseVersion is the documented optimistic-concurrency anchor.
          // Reject stale proposals whose anchor is no longer the effective
          // head — the schema FK only proves the version existed at some
          // point, not that it is current. We check AFTER the insert (not
          // before) so retries land in the content-compare branch below
          // even after the head advances; only fresh inserts pay this cost.
          // When the mutable head row is missing (partial corruption), fall
          // back to MAX(lineage version) — same effective-head policy that
          // structuredPlaybooks.save() uses, so proposal capture is not
          // wedged by the exact missing-head scenario the store self-heals.
          const headRow = selectStructuredHeadVersion.get(p.playbookId) as {
            readonly version: number;
          } | null;
          let effectiveHead: number | null;
          if (headRow !== null) {
            effectiveHead = headRow.version;
          } else {
            const lineageRow = selectStructuredLineageMaxVersion.get(p.playbookId) as {
              readonly v: number | null;
            } | null;
            effectiveHead = lineageRow?.v ?? null;
          }
          if (effectiveHead === null || effectiveHead !== p.baseVersion) {
            throw new Error(
              `proposal ${p.id} baseVersion ${String(p.baseVersion)} does not match current head ${effectiveHead === null ? "(missing)" : String(effectiveHead)} for playbook ${p.playbookId}`,
            );
          }
        }
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
