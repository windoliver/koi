import type { Database } from "bun:sqlite";

/**
 * Schema version tracked via SQLite's `PRAGMA user_version`. Bump when a
 * migration is required to bring legacy databases into compatibility.
 *
 * v1: playbook_evaluations gains FK(proposal_id) -> playbook_proposals(id) and
 *     UNIQUE(proposal_id). Legacy databases (user_version = 0) are rebuilt:
 *     orphan rows are dropped, duplicates per proposal_id keep the latest by
 *     evaluated_at.
 */
const CURRENT_SCHEMA_VERSION = 1;

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
      turn_index  INTEGER NOT NULL,
      timestamp   INTEGER NOT NULL,
      kind        TEXT    NOT NULL,
      identifier  TEXT    NOT NULL,
      outcome     TEXT    NOT NULL,
      duration_ms INTEGER NOT NULL,
      metadata    TEXT,
      bullet_ids  TEXT,
      PRIMARY KEY (session_id, turn_index, identifier)
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

  db.run(`
    CREATE TABLE IF NOT EXISTS playbook_proposals (
      id                      TEXT    PRIMARY KEY,
      playbook_id             TEXT    NOT NULL,
      base_version            INTEGER NOT NULL,
      operations              TEXT    NOT NULL,
      source_trajectory_range TEXT    NOT NULL,
      reflection              TEXT    NOT NULL,
      created_at              INTEGER NOT NULL
    )
  `);
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_playbook_proposals_playbook ON playbook_proposals(playbook_id, created_at)",
  );

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

  const proposalsExists = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='playbook_proposals'")
    .get() as { readonly name: string } | null;
  const validProposalIds = new Set<string>(
    proposalsExists !== null
      ? (
          db.query("SELECT id FROM playbook_proposals").all() as readonly { readonly id: string }[]
        ).map((r) => r.id)
      : [],
  );

  const legacyRows = db
    .query("SELECT * FROM playbook_evaluations")
    .all() as readonly LegacyEvalRow[];

  // Partition: orphans go to quarantine; for duplicate proposal_id keep the
  // latest by evaluated_at (id as tiebreaker), the rest go to quarantine.
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

  db.transaction(() => {
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
  })();
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
