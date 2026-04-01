/**
 * SqliteHandoffStore — bun:sqlite backend for persistent handoff envelopes.
 *
 * Schema: single `handoff_envelopes` table with JSON data + queryable columns.
 * WAL mode + prepared statements + parameterized CAS transitions.
 */

import type {
  AgentId,
  AgentRegistry,
  HandoffEnvelope,
  HandoffId,
  HandoffStatus,
  KoiError,
  RegistryEvent,
  Result,
} from "@koi/core";
import { agentId, handoffId } from "@koi/core";
import { openDb } from "@koi/sqlite-utils";
import { conflictError, expiredError, internalError, notFoundError } from "./errors.js";
import type { HandoffStore, HandoffStoreConfig } from "./store.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SqliteHandoffStoreConfig extends HandoffStoreConfig {
  /** Database file path, or ":memory:" for tests. */
  readonly dbPath: string;
}

/** Default TTL: 24 hours. */
const DEFAULT_TTL_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Row type
// ---------------------------------------------------------------------------

interface EnvelopeRow {
  readonly id: string;
  readonly data: string;
  readonly status: string;
  readonly from_agent: string;
  readonly to_agent: string;
  readonly created_at: number;
}

interface CountRow {
  readonly count: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapRowToEnvelope(row: EnvelopeRow): HandoffEnvelope {
  const parsed = JSON.parse(row.data) as HandoffEnvelope;
  // Re-apply branded constructors after deserialization
  return {
    ...parsed,
    id: handoffId(row.id),
    from: agentId(row.from_agent),
    to: agentId(row.to_agent),
    status: row.status as HandoffStatus,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSqliteHandoffStore(
  config: SqliteHandoffStoreConfig,
): HandoffStore & { readonly close: () => void } {
  const db = openDb(config.dbPath);
  const ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;

  // let justified: mutable registry unsubscribe callback
  let registryUnsubscribe: (() => void) | undefined;

  // -- Schema ---------------------------------------------------------------
  db.run(`
    CREATE TABLE IF NOT EXISTS handoff_envelopes (
      id         TEXT PRIMARY KEY,
      data       TEXT NOT NULL,
      status     TEXT NOT NULL,
      from_agent TEXT NOT NULL,
      to_agent   TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT
  `);

  db.run(
    "CREATE INDEX IF NOT EXISTS idx_handoff_to_status ON handoff_envelopes (to_agent, status)",
  );
  db.run("CREATE INDEX IF NOT EXISTS idx_handoff_from ON handoff_envelopes (from_agent)");
  db.run("CREATE INDEX IF NOT EXISTS idx_handoff_created ON handoff_envelopes (created_at)");

  // Startup cleanup: remove expired envelopes
  const cutoff = Date.now() - ttlMs;
  db.run("DELETE FROM handoff_envelopes WHERE created_at < ?", [cutoff]);

  // -- Prepared statements ---------------------------------------------------
  const insertStmt = db.prepare(`
    INSERT INTO handoff_envelopes (id, data, status, from_agent, to_agent, created_at)
    VALUES ($id, $data, $status, $from_agent, $to_agent, $created_at)
  `);

  const selectByIdStmt = db.query<EnvelopeRow, [string]>(
    "SELECT * FROM handoff_envelopes WHERE id = ?",
  );

  const updateStatusStmt = db.prepare(`
    UPDATE handoff_envelopes SET status = $to_status, data = $data
    WHERE id = $id AND status = $from_status
  `);

  const selectByAgentStmt = db.query<EnvelopeRow, [string, string]>(
    "SELECT * FROM handoff_envelopes WHERE from_agent = ? OR to_agent = ?",
  );

  const selectPendingStmt = db.query<EnvelopeRow, [string, number]>(`
    SELECT * FROM handoff_envelopes
    WHERE to_agent = ? AND status IN ('pending', 'injected') AND created_at > ?
    ORDER BY created_at ASC
    LIMIT 1
  `);

  const deleteByIdStmt = db.prepare("DELETE FROM handoff_envelopes WHERE id = ?");

  const deleteByAgentStmt = db.prepare(
    "DELETE FROM handoff_envelopes WHERE from_agent = ? OR to_agent = ?",
  );

  const countByIdStmt = db.query<CountRow, [string]>(
    "SELECT COUNT(*) AS count FROM handoff_envelopes WHERE id = ?",
  );

  // -- HandoffStore methods --------------------------------------------------

  function put(envelope: HandoffEnvelope): Result<void, KoiError> {
    try {
      insertStmt.run({
        $id: envelope.id,
        $data: JSON.stringify(envelope),
        $status: envelope.status,
        $from_agent: envelope.from,
        $to_agent: envelope.to,
        $created_at: envelope.createdAt,
      });
      return { ok: true, value: undefined };
    } catch (e: unknown) {
      if (e instanceof Error && e.message.includes("UNIQUE constraint failed")) {
        return { ok: false, error: conflictError(envelope.id) };
      }
      return { ok: false, error: internalError("Failed to insert handoff envelope", e) };
    }
  }

  function get(id: HandoffId): Result<HandoffEnvelope, KoiError> {
    try {
      const row = selectByIdStmt.get(id);
      if (row === null) {
        return { ok: false, error: notFoundError(id) };
      }
      // Check TTL
      if (row.created_at + ttlMs < Date.now()) {
        // Transition to expired
        updateStatusStmt.run({
          $id: id,
          $from_status: row.status,
          $to_status: "expired",
          $data: row.data.replace(/"status":"[^"]*"/, '"status":"expired"'),
        });
        return { ok: false, error: expiredError(id) };
      }
      return { ok: true, value: mapRowToEnvelope(row) };
    } catch (e: unknown) {
      return { ok: false, error: internalError("Failed to get handoff envelope", e) };
    }
  }

  function transition(
    id: HandoffId,
    from: HandoffStatus,
    to: HandoffStatus,
  ): Result<HandoffEnvelope, KoiError> {
    try {
      // Read current envelope for data update
      const row = selectByIdStmt.get(id);
      if (row === null || row.status !== from) {
        return { ok: false, error: notFoundError(id) };
      }

      const envelope = mapRowToEnvelope(row);
      const updated: HandoffEnvelope = { ...envelope, status: to };
      const newData = JSON.stringify(updated);

      const changes = updateStatusStmt.run({
        $id: id,
        $from_status: from,
        $to_status: to,
        $data: newData,
      });

      if (changes.changes === 0) {
        // CAS mismatch — another process transitioned first
        return { ok: false, error: notFoundError(id) };
      }

      return { ok: true, value: updated };
    } catch (e: unknown) {
      return { ok: false, error: internalError("Failed to transition handoff envelope", e) };
    }
  }

  function listByAgent(aid: AgentId): Result<readonly HandoffEnvelope[], KoiError> {
    try {
      const rows = selectByAgentStmt.all(aid, aid);
      return { ok: true, value: rows.map(mapRowToEnvelope) };
    } catch (e: unknown) {
      return { ok: false, error: internalError("Failed to list handoff envelopes", e) };
    }
  }

  function findPendingForAgent(aid: AgentId): Result<HandoffEnvelope | undefined, KoiError> {
    try {
      const minCreatedAt = Date.now() - ttlMs;
      const row = selectPendingStmt.get(aid, minCreatedAt);
      if (row === null) {
        return { ok: true, value: undefined };
      }
      return { ok: true, value: mapRowToEnvelope(row) };
    } catch (e: unknown) {
      return { ok: false, error: internalError("Failed to find pending handoff", e) };
    }
  }

  function remove(id: HandoffId): Result<boolean, KoiError> {
    try {
      const row = countByIdStmt.get(id);
      if (row === null || row.count === 0) {
        return { ok: true, value: false };
      }
      deleteByIdStmt.run(id);
      return { ok: true, value: true };
    } catch (e: unknown) {
      return { ok: false, error: internalError("Failed to remove handoff envelope", e) };
    }
  }

  function removeByAgent(aid: AgentId): Result<void, KoiError> {
    try {
      deleteByAgentStmt.run(aid, aid);
      return { ok: true, value: undefined };
    } catch (e: unknown) {
      return { ok: false, error: internalError("Failed to remove agent handoffs", e) };
    }
  }

  function bindRegistry(registry: AgentRegistry): void {
    registryUnsubscribe?.();
    registryUnsubscribe = registry.watch((event: RegistryEvent) => {
      if (event.kind === "transitioned" && event.to === "terminated") {
        removeByAgent(event.agentId);
      } else if (event.kind === "deregistered") {
        removeByAgent(event.agentId);
      }
    });
  }

  function close(): void {
    registryUnsubscribe?.();
    registryUnsubscribe = undefined;
    db.close();
  }

  return {
    put,
    get,
    transition,
    listByAgent,
    findPendingForAgent,
    remove,
    removeByAgent,
    bindRegistry,
    dispose: close,
    close,
  };
}
