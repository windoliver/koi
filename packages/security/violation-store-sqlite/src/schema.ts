/**
 * SQLite schema for the violations table.
 * WAL mode + indexes on timestamp, agent, and severity.
 * Append-only: no UPDATE or DELETE statements live in this package.
 */

import type { Database, Statement } from "bun:sqlite";

const PRAGMA_WAL = "PRAGMA journal_mode = WAL";

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS violations (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp      INTEGER NOT NULL,
    rule           TEXT    NOT NULL,
    severity       TEXT    NOT NULL,
    message        TEXT    NOT NULL,
    context_json   TEXT,
    agent_id       TEXT    NOT NULL,
    session_id     TEXT
  )
`;

const CREATE_IDX_TS = `
  CREATE INDEX IF NOT EXISTS idx_violations_ts
  ON violations(timestamp DESC)
`;

const CREATE_IDX_AGENT_TS = `
  CREATE INDEX IF NOT EXISTS idx_violations_agent_ts
  ON violations(agent_id, timestamp DESC)
`;

const CREATE_IDX_SEV_TS = `
  CREATE INDEX IF NOT EXISTS idx_violations_sev_ts
  ON violations(severity, timestamp DESC)
`;

export function initViolationSchema(db: Database): void {
  db.run(PRAGMA_WAL);
  db.run(CREATE_TABLE);
  db.run(CREATE_IDX_TS);
  db.run(CREATE_IDX_AGENT_TS);
  db.run(CREATE_IDX_SEV_TS);
}

export function createInsertStmt(db: Database): Statement {
  return db.prepare(`
    INSERT INTO violations (
      timestamp, rule, severity, message, context_json, agent_id, session_id
    ) VALUES (
      $timestamp, $rule, $severity, $message, $contextJson, $agentId, $sessionId
    )
  `);
}

export interface ViolationRow {
  readonly id: number;
  readonly timestamp: number;
  readonly rule: string;
  readonly severity: string;
  readonly message: string;
  readonly context_json: string | null;
  readonly agent_id: string;
  readonly session_id: string | null;
}
