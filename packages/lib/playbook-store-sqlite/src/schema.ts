import type { Database } from "bun:sqlite";

/**
 * Schema version tracked via SQLite's `PRAGMA user_version`. Bump when a
 * migration is required to bring legacy databases into compatibility.
 *
 * v1: playbook_evaluations gains FK(proposal_id) -> playbook_proposals(id) and
 *     UNIQUE(proposal_id). Legacy databases (user_version = 0) are rebuilt:
 *     orphan rows are dropped, duplicates per proposal_id keep the latest by
 *     evaluated_at.
 *
 * v2: trajectory_entries primary key changes from
 *     (session_id, turn_index, identifier) to (session_id, seq), where seq is
 *     a per-session monotonic counter assigned at append time. The legacy PK
 *     collapsed multiple same-turn calls to the same tool/model into a single
 *     row, losing replay/audit fidelity. Legacy rows are migrated by
 *     assigning seq = ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY
 *     turn_index, identifier).
 *
 * v3: playbook_proposals gains composite FK
 *     (playbook_id, base_version) -> structured_playbook_versions(playbook_id, version)
 *     so a proposal can never claim ancestry on a nonexistent playbook
 *     version. Without this anchor, downstream promotion/rollback can't prove
 *     what snapshot was actually reviewed. Adds new
 *     `trajectory_append_log` table for caller-transparent dedup of
 *     byte-identical replayed batches: append() hashes the entries and
 *     short-circuits when the same hash was already recorded for this session.
 */
const CURRENT_SCHEMA_VERSION = 3;

export function applyPragmas(db: Database, durability: "process" | "os"): void {
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA wal_autocheckpoint = 1000");
  db.run(`PRAGMA synchronous = ${durability === "os" ? "FULL" : "NORMAL"}`);
}

export function applySchema(db: Database): void {
  const versionRow = db.query("PRAGMA user_version").get() as {
    readonly user_version: number;
  } | null;
  const fromVersion = versionRow?.user_version ?? 0;

  db.run(`
    CREATE TABLE IF NOT EXISTS trajectory_entries (
      session_id  TEXT    NOT NULL,
      seq         INTEGER NOT NULL,
      turn_index  INTEGER NOT NULL,
      timestamp   INTEGER NOT NULL,
      kind        TEXT    NOT NULL,
      identifier  TEXT    NOT NULL,
      outcome     TEXT    NOT NULL,
      duration_ms INTEGER NOT NULL,
      metadata    TEXT,
      bullet_ids  TEXT,
      PRIMARY KEY (session_id, seq)
    )
  `);
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_trajectory_entries_session ON trajectory_entries(session_id, turn_index)",
  );

  db.run(`
    CREATE TABLE IF NOT EXISTS playbooks (
      id            TEXT    PRIMARY KEY,
      title         TEXT    NOT NULL,
      strategy      TEXT    NOT NULL,
      tags          TEXT    NOT NULL DEFAULT '[]',
      confidence    REAL    NOT NULL,
      source        TEXT    NOT NULL,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      session_count INTEGER NOT NULL,
      version       INTEGER NOT NULL,
      provenance    TEXT
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_playbooks_confidence ON playbooks(confidence)");

  db.run(`
    CREATE TABLE IF NOT EXISTS structured_playbooks (
      id                        TEXT    PRIMARY KEY,
      title                     TEXT    NOT NULL,
      sections                  TEXT    NOT NULL,
      tags                      TEXT    NOT NULL DEFAULT '[]',
      source                    TEXT    NOT NULL,
      created_at                INTEGER NOT NULL,
      updated_at                INTEGER NOT NULL,
      session_count             INTEGER NOT NULL,
      last_reflected_step_index INTEGER,
      version                   INTEGER NOT NULL,
      provenance                TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS structured_playbook_versions (
      playbook_id  TEXT    NOT NULL,
      version      INTEGER NOT NULL,
      snapshot     TEXT    NOT NULL,
      committed_at INTEGER NOT NULL,
      PRIMARY KEY (playbook_id, version)
    )
  `);

  // Composite FK (playbook_id, base_version) -> structured_playbook_versions
  // anchors every proposal to a real committed playbook snapshot. Without
  // this, downstream promotion/rollback couldn't prove what snapshot was
  // reviewed.
  db.run(`
    CREATE TABLE IF NOT EXISTS playbook_proposals (
      id                      TEXT    PRIMARY KEY,
      playbook_id             TEXT    NOT NULL,
      base_version            INTEGER NOT NULL,
      operations              TEXT    NOT NULL,
      source_trajectory_range TEXT    NOT NULL,
      reflection              TEXT    NOT NULL,
      created_at              INTEGER NOT NULL,
      FOREIGN KEY (playbook_id, base_version)
        REFERENCES structured_playbook_versions(playbook_id, version)
        ON DELETE RESTRICT
    )
  `);
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_playbook_proposals_playbook ON playbook_proposals(playbook_id, created_at)",
  );

  // Per-session batch dedup: idempotent retry of the same byte-identical
  // entries array short-circuits without inserting duplicates. Caller can
  // safely retry an append after an unknown-commit-state failure.
  db.run(`
    CREATE TABLE IF NOT EXISTS trajectory_append_log (
      session_id   TEXT    NOT NULL,
      batch_hash   TEXT    NOT NULL,
      appended_at  INTEGER NOT NULL,
      PRIMARY KEY (session_id, batch_hash)
    )
  `);

  // FK to playbook_proposals.id rejects orphan evaluations (must reference an
  // existing proposal). UNIQUE(proposal_id) enforces one evaluation per
  // proposal so the audit log has a single authoritative verdict.
  db.run(`
    CREATE TABLE IF NOT EXISTS playbook_evaluations (
      id           TEXT    PRIMARY KEY,
      proposal_id  TEXT    NOT NULL UNIQUE
                   REFERENCES playbook_proposals(id) ON DELETE RESTRICT,
      verdict      TEXT    NOT NULL,
      metrics      TEXT    NOT NULL,
      notes        TEXT,
      evaluated_at INTEGER NOT NULL
    )
  `);

  // Run migrations AFTER all CREATE IF NOT EXISTS so a rebuild can reference
  // sibling tables (e.g. evaluations FK to proposals) that the migration may
  // need to exist. CREATE IF NOT EXISTS is a no-op when the legacy shape is
  // already present, leaving the rebuild to migrateEvaluationsToV1.
  if (fromVersion < 1) {
    migrateEvaluationsToV1(db);
  }
  if (fromVersion < 2) {
    migrateTrajectoriesToV2(db);
  }
  if (fromVersion < 3) {
    migrateProposalsToV3(db);
  }
  if (fromVersion < CURRENT_SCHEMA_VERSION) {
    db.run(`PRAGMA user_version = ${String(CURRENT_SCHEMA_VERSION)}`);
  }
}

interface LegacyEvalRow {
  readonly id: string;
  readonly proposal_id: string;
  readonly verdict: string;
  readonly metrics: string;
  readonly notes: string | null;
  readonly evaluated_at: number;
}

/**
 * Rebuild `playbook_evaluations` if it lacks either the UNIQUE(proposal_id)
 * constraint or the FK to `playbook_proposals(id)`. The decision is based on
 * inspecting both `PRAGMA index_list` and `PRAGMA foreign_key_list` rather
 * than regex-matching the original DDL — a drifted DB with one constraint
 * but not the other must still be rebuilt before user_version is bumped.
 *
 * Discarded rows (orphans, duplicate non-winners) are NOT deleted — they are
 * moved to `playbook_evaluations_quarantine_v1` with a `reason` column so
 * operators can audit what migration repaired. No legacy evidence is lost.
 *
 * No-op when the table doesn't exist (fresh database) or already has both
 * the UNIQUE and FK invariants.
 */
function migrateEvaluationsToV1(db: Database): void {
  const tableInfo = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='playbook_evaluations'")
    .get() as { readonly name: string } | null;
  if (tableInfo === null) return;
  if (evaluationsConstraintsSatisfied(db)) return;

  // Read + write inside .immediate(): the RESERVED lock at BEGIN serializes
  // against concurrent peer writers, so a row committed mid-migration on a
  // shared SQLite file cannot be erased by the rebuild.
  db.transaction(() => {
    const proposalsExists = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='playbook_proposals'")
      .get() as { readonly name: string } | null;
    const validProposalIds = new Set<string>(
      proposalsExists !== null
        ? (
            db.query("SELECT id FROM playbook_proposals").all() as readonly {
              readonly id: string;
            }[]
          ).map((r) => r.id)
        : [],
    );

    const legacyRows = db
      .query("SELECT * FROM playbook_evaluations")
      .all() as readonly LegacyEvalRow[];

    // Partition: orphans go to quarantine; for duplicate proposal_id keep
    // the latest by evaluated_at (id as tiebreaker), the rest go to
    // quarantine.
    const winners = new Map<string, LegacyEvalRow>();
    const quarantine: { readonly row: LegacyEvalRow; readonly reason: string }[] = [];
    for (const row of legacyRows) {
      if (!validProposalIds.has(row.proposal_id)) {
        quarantine.push({ row, reason: "orphan: proposal_id not in playbook_proposals" });
        continue;
      }
      const existing = winners.get(row.proposal_id);
      if (existing === undefined) {
        winners.set(row.proposal_id, row);
        continue;
      }
      const incomingWins =
        row.evaluated_at > existing.evaluated_at ||
        (row.evaluated_at === existing.evaluated_at && row.id > existing.id);
      if (incomingWins) {
        quarantine.push({ row: existing, reason: "duplicate: superseded by later evaluated_at" });
        winners.set(row.proposal_id, row);
      } else {
        quarantine.push({ row, reason: "duplicate: superseded by later evaluated_at" });
      }
    }

    db.run(`
      CREATE TABLE IF NOT EXISTS playbook_evaluations_quarantine_v1 (
        id           TEXT    NOT NULL,
        proposal_id  TEXT    NOT NULL,
        verdict      TEXT    NOT NULL,
        metrics      TEXT    NOT NULL,
        notes        TEXT,
        evaluated_at INTEGER NOT NULL,
        reason       TEXT    NOT NULL,
        quarantined_at INTEGER NOT NULL
      )
    `);
    const quarantineInsert = db.prepare(
      "INSERT INTO playbook_evaluations_quarantine_v1 (id, proposal_id, verdict, metrics, notes, evaluated_at, reason, quarantined_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const now = Date.now();
    for (const entry of quarantine) {
      const r = entry.row;
      quarantineInsert.run(
        r.id,
        r.proposal_id,
        r.verdict,
        r.metrics,
        r.notes,
        r.evaluated_at,
        entry.reason,
        now,
      );
    }

    db.run("DROP TABLE playbook_evaluations");
    db.run(`
      CREATE TABLE playbook_evaluations (
        id           TEXT    PRIMARY KEY,
        proposal_id  TEXT    NOT NULL UNIQUE
                     REFERENCES playbook_proposals(id) ON DELETE RESTRICT,
        verdict      TEXT    NOT NULL,
        metrics      TEXT    NOT NULL,
        notes        TEXT,
        evaluated_at INTEGER NOT NULL
      )
    `);
    const insert = db.prepare(
      "INSERT INTO playbook_evaluations (id, proposal_id, verdict, metrics, notes, evaluated_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const row of winners.values()) {
      insert.run(row.id, row.proposal_id, row.verdict, row.metrics, row.notes, row.evaluated_at);
    }
  }).immediate();
}

/**
 * True iff `playbook_evaluations` has both UNIQUE on `proposal_id` and a FK
 * pointing to `playbook_proposals(id)`. If either is missing the table needs
 * to be rebuilt before user_version is advanced.
 */
function evaluationsConstraintsSatisfied(db: Database): boolean {
  const indexes = db.query("PRAGMA index_list(playbook_evaluations)").all() as readonly {
    readonly name: string;
    readonly unique: number;
  }[];
  let hasUnique = false;
  for (const idx of indexes) {
    if (idx.unique !== 1) continue;
    const cols = db.query(`PRAGMA index_info(${quoteIdentifier(idx.name)})`).all() as readonly {
      readonly name: string;
    }[];
    if (cols.length === 1 && cols[0]?.name === "proposal_id") {
      hasUnique = true;
      break;
    }
  }
  if (!hasUnique) return false;

  const fks = db.query("PRAGMA foreign_key_list(playbook_evaluations)").all() as readonly {
    readonly table: string;
    readonly from: string;
    readonly to: string;
  }[];
  return fks.some(
    (fk) => fk.table === "playbook_proposals" && fk.from === "proposal_id" && fk.to === "id",
  );
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

interface LegacyTrajectoryRow {
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

/**
 * Migrate trajectory_entries from PK (session_id, turn_index, identifier) to
 * (session_id, seq). The legacy PK collapsed multiple same-tool calls in one
 * turn into a single row; the new PK preserves every call as a distinct row.
 *
 * No-op when the table already has the `seq` column (CREATE IF NOT EXISTS in
 * applySchema may have emitted the new shape on a fresh DB).
 */
function migrateTrajectoriesToV2(db: Database): void {
  const cols = db.query("PRAGMA table_info(trajectory_entries)").all() as readonly {
    readonly name: string;
  }[];
  if (cols.length === 0) return;
  if (cols.some((c) => c.name === "seq")) return;

  // RESERVED lock at BEGIN serializes against concurrent writers on the same
  // SQLite file: read of legacy rows + DROP + INSERT must observe a stable
  // snapshot, otherwise a peer's INSERT can be erased by the rebuild.
  db.transaction(() => {
    // Order legacy rows by `rowid` (insertion order) within each session,
    // tie-breaking on `timestamp` for paranoia. ORDER BY (turn_index,
    // identifier) would invent a fabricated ordering for same-turn rows
    // whose original append order is what downstream replay relies on.
    const legacyRows = db
      .query(
        "SELECT session_id, turn_index, timestamp, kind, identifier, outcome, duration_ms, metadata, bullet_ids FROM trajectory_entries ORDER BY session_id, rowid, timestamp",
      )
      .all() as readonly LegacyTrajectoryRow[];

    db.run("DROP TABLE trajectory_entries");
    db.run(`
      CREATE TABLE trajectory_entries (
        session_id  TEXT    NOT NULL,
        seq         INTEGER NOT NULL,
        turn_index  INTEGER NOT NULL,
        timestamp   INTEGER NOT NULL,
        kind        TEXT    NOT NULL,
        identifier  TEXT    NOT NULL,
        outcome     TEXT    NOT NULL,
        duration_ms INTEGER NOT NULL,
        metadata    TEXT,
        bullet_ids  TEXT,
        PRIMARY KEY (session_id, seq)
      )
    `);
    db.run(
      "CREATE INDEX IF NOT EXISTS idx_trajectory_entries_session ON trajectory_entries(session_id, turn_index)",
    );
    const insert = db.prepare(
      "INSERT INTO trajectory_entries (session_id, seq, turn_index, timestamp, kind, identifier, outcome, duration_ms, metadata, bullet_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const seqBySession = new Map<string, number>();
    for (const r of legacyRows) {
      const next = (seqBySession.get(r.session_id) ?? 0) + 1;
      seqBySession.set(r.session_id, next);
      insert.run(
        r.session_id,
        next,
        r.turn_index,
        r.timestamp,
        r.kind,
        r.identifier,
        r.outcome,
        r.duration_ms,
        r.metadata,
        r.bullet_ids,
      );
    }
  }).immediate();
}

interface LegacyProposalRow {
  readonly id: string;
  readonly playbook_id: string;
  readonly base_version: number;
  readonly operations: string;
  readonly source_trajectory_range: string;
  readonly reflection: string;
  readonly created_at: number;
}

/**
 * Migrate playbook_proposals to add composite FK
 * (playbook_id, base_version) -> structured_playbook_versions(playbook_id, version).
 *
 * Orphan proposals (no matching version row) are quarantined to
 * `playbook_proposals_quarantine_v3` with a reason; the new table accepts
 * only proposals whose lineage anchor exists. No-op when the table already
 * has the FK or doesn't exist.
 */
function migrateProposalsToV3(db: Database): void {
  const tableInfo = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='playbook_proposals'")
    .get() as { readonly name: string } | null;
  if (tableInfo === null) return;
  if (proposalsLineageFkSatisfied(db)) return;

  // All reads + writes happen inside .immediate(): the RESERVED lock is
  // acquired at BEGIN, so a concurrent writer on the same SQLite file cannot
  // commit a new proposal between our snapshot read and the rebuild — the
  // peer must wait, retry against the rebuilt schema, and is then subject to
  // the new FK.
  db.transaction(() => {
    const versionRows = db
      .query("SELECT playbook_id, version FROM structured_playbook_versions")
      .all() as readonly { readonly playbook_id: string; readonly version: number }[];
    const validAnchors = new Set<string>(
      versionRows.map((r) => `${r.playbook_id}::${String(r.version)}`),
    );
    const legacyProposals = db
      .query("SELECT * FROM playbook_proposals")
      .all() as readonly LegacyProposalRow[];

    const winners: LegacyProposalRow[] = [];
    const orphanProposals: LegacyProposalRow[] = [];
    for (const r of legacyProposals) {
      if (validAnchors.has(`${r.playbook_id}::${String(r.base_version)}`)) {
        winners.push(r);
      } else {
        orphanProposals.push(r);
      }
    }
    const validProposalIds = new Set(winners.map((w) => w.id));
    const orphanProposalIds = new Set(orphanProposals.map((o) => o.id));

    const savedEvals = db
      .query(
        "SELECT id, proposal_id, verdict, metrics, notes, evaluated_at FROM playbook_evaluations",
      )
      .all() as readonly {
      readonly id: string;
      readonly proposal_id: string;
      readonly verdict: string;
      readonly metrics: string;
      readonly notes: string | null;
      readonly evaluated_at: number;
    }[];

    db.run(`
      CREATE TABLE IF NOT EXISTS playbook_proposals_quarantine_v3 (
        id                      TEXT    NOT NULL,
        playbook_id             TEXT    NOT NULL,
        base_version            INTEGER NOT NULL,
        operations              TEXT    NOT NULL,
        source_trajectory_range TEXT    NOT NULL,
        reflection              TEXT    NOT NULL,
        created_at              INTEGER NOT NULL,
        reason                  TEXT    NOT NULL,
        quarantined_at          INTEGER NOT NULL
      )
    `);
    // Quarantine evaluations whose proposal was orphaned, alongside the
    // proposals — append-only audit trail must not lose evidence even when
    // its anchor was invalid.
    db.run(`
      CREATE TABLE IF NOT EXISTS playbook_evaluations_quarantine_v3 (
        id           TEXT    NOT NULL,
        proposal_id  TEXT    NOT NULL,
        verdict      TEXT    NOT NULL,
        metrics      TEXT    NOT NULL,
        notes        TEXT,
        evaluated_at INTEGER NOT NULL,
        reason       TEXT    NOT NULL,
        quarantined_at INTEGER NOT NULL
      )
    `);
    const qPropInsert = db.prepare(
      "INSERT INTO playbook_proposals_quarantine_v3 (id, playbook_id, base_version, operations, source_trajectory_range, reflection, created_at, reason, quarantined_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const qEvalInsert = db.prepare(
      "INSERT INTO playbook_evaluations_quarantine_v3 (id, proposal_id, verdict, metrics, notes, evaluated_at, reason, quarantined_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const now = Date.now();
    for (const r of orphanProposals) {
      qPropInsert.run(
        r.id,
        r.playbook_id,
        r.base_version,
        r.operations,
        r.source_trajectory_range,
        r.reflection,
        r.created_at,
        "orphan: (playbook_id, base_version) not in structured_playbook_versions",
        now,
      );
    }
    for (const e of savedEvals) {
      if (orphanProposalIds.has(e.proposal_id) || !validProposalIds.has(e.proposal_id)) {
        qEvalInsert.run(
          e.id,
          e.proposal_id,
          e.verdict,
          e.metrics,
          e.notes,
          e.evaluated_at,
          orphanProposalIds.has(e.proposal_id)
            ? "proposal quarantined as orphan"
            : "proposal_id not in playbook_proposals",
          now,
        );
      }
    }

    db.run("DROP TABLE IF EXISTS playbook_evaluations");
    db.run("DROP TABLE playbook_proposals");
    db.run(`
      CREATE TABLE playbook_proposals (
        id                      TEXT    PRIMARY KEY,
        playbook_id             TEXT    NOT NULL,
        base_version            INTEGER NOT NULL,
        operations              TEXT    NOT NULL,
        source_trajectory_range TEXT    NOT NULL,
        reflection              TEXT    NOT NULL,
        created_at              INTEGER NOT NULL,
        FOREIGN KEY (playbook_id, base_version)
          REFERENCES structured_playbook_versions(playbook_id, version)
          ON DELETE RESTRICT
      )
    `);
    db.run(
      "CREATE INDEX IF NOT EXISTS idx_playbook_proposals_playbook ON playbook_proposals(playbook_id, created_at)",
    );
    const propInsert = db.prepare(
      "INSERT INTO playbook_proposals (id, playbook_id, base_version, operations, source_trajectory_range, reflection, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const r of winners) {
      propInsert.run(
        r.id,
        r.playbook_id,
        r.base_version,
        r.operations,
        r.source_trajectory_range,
        r.reflection,
        r.created_at,
      );
    }

    db.run(`
      CREATE TABLE playbook_evaluations (
        id           TEXT    PRIMARY KEY,
        proposal_id  TEXT    NOT NULL UNIQUE
                     REFERENCES playbook_proposals(id) ON DELETE RESTRICT,
        verdict      TEXT    NOT NULL,
        metrics      TEXT    NOT NULL,
        notes        TEXT,
        evaluated_at INTEGER NOT NULL
      )
    `);
    const evalInsert = db.prepare(
      "INSERT INTO playbook_evaluations (id, proposal_id, verdict, metrics, notes, evaluated_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const e of savedEvals) {
      if (validProposalIds.has(e.proposal_id)) {
        evalInsert.run(e.id, e.proposal_id, e.verdict, e.metrics, e.notes, e.evaluated_at);
      }
    }
  }).immediate();
}

function proposalsLineageFkSatisfied(db: Database): boolean {
  const fks = db.query("PRAGMA foreign_key_list(playbook_proposals)").all() as readonly {
    readonly table: string;
    readonly from: string;
    readonly to: string;
  }[];
  // Composite FKs appear as multiple rows with the same `id`; we only need
  // to confirm both columns target structured_playbook_versions.
  const targets = fks.filter((fk) => fk.table === "structured_playbook_versions");
  const fromCols = new Set(targets.map((fk) => fk.from));
  return fromCols.has("playbook_id") && fromCols.has("base_version");
}
