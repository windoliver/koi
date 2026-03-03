/**
 * SQLite schema for the audit log table.
 */

import type { Database, Statement } from "bun:sqlite";

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    turn_index INTEGER NOT NULL,
    kind TEXT NOT NULL,
    request TEXT,
    response TEXT,
    error TEXT,
    duration_ms INTEGER NOT NULL,
    metadata TEXT
  )
`;

const CREATE_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_audit_log_session ON audit_log(session_id)
`;

/** Initialize the audit schema on the given database. */
export function initAuditSchema(db: Database): void {
  db.run(CREATE_TABLE);
  db.run(CREATE_INDEX);
}

/** Prepared insert statement for batch operations. */
export function createInsertStmt(db: Database): Statement {
  return db.prepare(
    `INSERT INTO audit_log (timestamp, session_id, agent_id, turn_index, kind, request, response, error, duration_ms, metadata)
     VALUES ($timestamp, $sessionId, $agentId, $turnIndex, $kind, $request, $response, $error, $durationMs, $metadata)`,
  );
}

/** Read all audit entries from the database ordered by id. */
export function readAllAuditEntries(db: Database): readonly {
  readonly timestamp: number;
  readonly session_id: string;
  readonly agent_id: string;
  readonly turn_index: number;
  readonly kind: string;
  readonly request: string | null;
  readonly response: string | null;
  readonly error: string | null;
  readonly duration_ms: number;
  readonly metadata: string | null;
}[] {
  return db.prepare("SELECT * FROM audit_log ORDER BY id ASC").all() as readonly {
    readonly timestamp: number;
    readonly session_id: string;
    readonly agent_id: string;
    readonly turn_index: number;
    readonly kind: string;
    readonly request: string | null;
    readonly response: string | null;
    readonly error: string | null;
    readonly duration_ms: number;
    readonly metadata: string | null;
  }[];
}
