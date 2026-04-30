import type { Database } from "bun:sqlite";

export function applyPragmas(db: Database, durability: "process" | "os"): void {
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA wal_autocheckpoint = 1000");
  db.run(`PRAGMA synchronous = ${durability === "os" ? "FULL" : "NORMAL"}`);
}

export function applySchema(db: Database): void {
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

  db.run(`
    CREATE TABLE IF NOT EXISTS playbook_evaluations (
      id           TEXT    PRIMARY KEY,
      proposal_id  TEXT    NOT NULL,
      verdict      TEXT    NOT NULL,
      metrics      TEXT    NOT NULL,
      notes        TEXT,
      evaluated_at INTEGER NOT NULL
    )
  `);
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_playbook_evaluations_proposal ON playbook_evaluations(proposal_id)",
  );
}
