/**
 * approval-store.ts — SQLite-backed persistent approval memory.
 *
 * Stores "always" scope grants that survive process restart.
 * Keyed by (userId, agentId, toolId) to prevent cross-user grant inheritance.
 * Versioned by schemaVersion so policy/tool changes invalidate stale grants.
 *
 * Uses bun:sqlite (synchronous prepared statements) for sub-microsecond lookups.
 */

import { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Current schema version. Bump when grant semantics change. */
const CURRENT_SCHEMA_VERSION = 1;

export interface ApprovalStoreConfig {
  /** SQLite file path, or ":memory:" for tests. */
  readonly dbPath: string;
  /**
   * Application-level version stamp. Grants created under a different version
   * are ignored on lookup and pruned on next grant. Use this to invalidate
   * stale approvals when tool behavior, policy rules, or approval semantics
   * change. Defaults to CURRENT_SCHEMA_VERSION.
   */
  readonly schemaVersion?: number;
}

export interface ApprovalGrant {
  readonly userId: string;
  readonly agentId: string;
  readonly toolId: string;
  readonly grantedAt: number;
}

export interface ApprovalStore {
  /** Check if a persistent always-allow grant exists for the current schema version. */
  readonly has: (userId: string, agentId: string, toolId: string) => boolean;
  /** Record a persistent always-allow grant (upsert — updates grantedAt if exists). */
  readonly grant: (userId: string, agentId: string, toolId: string, grantedAt: number) => void;
  /** Revoke a specific grant. Returns true if a grant existed. */
  readonly revoke: (userId: string, agentId: string, toolId: string) => boolean;
  /** Revoke all grants. */
  readonly revokeAll: () => void;
  /** List all grants for the current schema version (for UI/diagnostics). */
  readonly list: () => readonly ApprovalGrant[];
  /** Close the database. Idempotent. */
  readonly close: () => void;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS approval_grants (
  user_id         TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  tool_id         TEXT NOT NULL,
  granted_at      INTEGER NOT NULL,
  schema_version  INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, agent_id, tool_id)
);
`;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createApprovalStore(config: ApprovalStoreConfig): ApprovalStore {
  const db = new Database(config.dbPath);
  const version = config.schemaVersion ?? CURRENT_SCHEMA_VERSION;

  // WAL mode for concurrent read/write access across sessions.
  db.exec("PRAGMA journal_mode = WAL;");
  // Wait up to 3s on lock contention instead of failing immediately.
  db.exec("PRAGMA busy_timeout = 3000;");
  // Create schema.
  db.exec(SCHEMA);
  // No startup pruning of mismatched schema versions — lookups are filtered
  // by version, so stale rows are invisible but preserved for rollback safety.

  // Prepared statements — cached by bun:sqlite, reused across calls.
  const stmtHas = db.prepare(
    "SELECT 1 AS found FROM approval_grants WHERE user_id = ? AND agent_id = ? AND tool_id = ? AND schema_version = ? LIMIT 1",
  );
  const stmtGrant = db.prepare(
    "INSERT INTO approval_grants (user_id, agent_id, tool_id, granted_at, schema_version) VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id, agent_id, tool_id) DO UPDATE SET granted_at = excluded.granted_at, schema_version = excluded.schema_version",
  );
  const stmtRevoke = db.prepare(
    "DELETE FROM approval_grants WHERE user_id = ? AND agent_id = ? AND tool_id = ?",
  );
  const stmtRevokeAll = db.prepare("DELETE FROM approval_grants");
  const stmtList = db.prepare(
    "SELECT user_id AS userId, agent_id AS agentId, tool_id AS toolId, granted_at AS grantedAt FROM approval_grants WHERE schema_version = ? ORDER BY granted_at DESC",
  );

  // let: closed tracks whether close() has been called
  let closed = false;

  return {
    has(userId: string, agentId: string, toolId: string): boolean {
      return stmtHas.get(userId, agentId, toolId, version) !== null;
    },

    grant(userId: string, agentId: string, toolId: string, grantedAt: number): void {
      stmtGrant.run(userId, agentId, toolId, grantedAt, version);
    },

    revoke(userId: string, agentId: string, toolId: string): boolean {
      const result = stmtRevoke.run(userId, agentId, toolId);
      return result.changes > 0;
    },

    revokeAll(): void {
      stmtRevokeAll.run();
    },

    list(): readonly ApprovalGrant[] {
      return stmtList.all(version) as ApprovalGrant[];
    },

    close(): void {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
