/**
 * SQLite schema for the audit_log table.
 *
 * WAL mode enabled for concurrent read/write access.
 * Composite (timestamp, kind) index for time-range + kind queries.
 */

import type { Database, Statement } from "bun:sqlite";

const PRAGMA_WAL = "PRAGMA journal_mode = WAL";

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS audit_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    schema_version INTEGER NOT NULL,
    timestamp      INTEGER NOT NULL,
    session_id     TEXT    NOT NULL,
    agent_id       TEXT    NOT NULL,
    turn_index     INTEGER NOT NULL,
    kind           TEXT    NOT NULL,
    request        TEXT,
    response       TEXT,
    error          TEXT,
    duration_ms    INTEGER NOT NULL,
    prev_hash      TEXT,
    signature      TEXT,
    metadata       TEXT
  )
`;

const CREATE_INDEX_SESSION = `
  CREATE INDEX IF NOT EXISTS idx_audit_log_session
  ON audit_log(session_id)
`;

const CREATE_INDEX_TS_KIND = `
  CREATE INDEX IF NOT EXISTS idx_audit_log_ts_kind
  ON audit_log(timestamp, kind)
`;

/** Initialize the audit schema and WAL mode on the given database. */
export function initAuditSchema(db: Database): void {
  db.run(PRAGMA_WAL);
  db.run(CREATE_TABLE);
  db.run(CREATE_INDEX_SESSION);
  db.run(CREATE_INDEX_TS_KIND);
}

/** Prepared insert statement for batch operations. */
export function createInsertStmt(db: Database): Statement {
  return db.prepare(`
    INSERT INTO audit_log (
      schema_version, timestamp, session_id, agent_id, turn_index,
      kind, request, response, error, duration_ms,
      prev_hash, signature, metadata
    ) VALUES (
      $schemaVersion, $timestamp, $sessionId, $agentId, $turnIndex,
      $kind, $request, $response, $error, $durationMs,
      $prevHash, $signature, $metadata
    )
  `);
}

/** Raw row shape as returned by bun:sqlite. All fields are the DB column types. */
export interface AuditLogRow {
  readonly id: number;
  readonly schema_version: number;
  readonly timestamp: number;
  readonly session_id: string;
  readonly agent_id: string;
  readonly turn_index: number;
  readonly kind: string;
  readonly request: string | null;
  readonly response: string | null;
  readonly error: string | null;
  readonly duration_ms: number;
  readonly prev_hash: string | null;
  readonly signature: string | null;
  readonly metadata: string | null;
}

/** Read all audit entries ordered by id. */
export function readAllRows(db: Database): readonly AuditLogRow[] {
  return db.prepare("SELECT * FROM audit_log ORDER BY id ASC").all() as AuditLogRow[];
}
