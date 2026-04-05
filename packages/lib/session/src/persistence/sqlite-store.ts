/**
 * SqliteSessionPersistence — bun:sqlite backend for durable session storage.
 *
 * WAL mode for crash durability. synchronous=NORMAL by default (process-crash
 * durable), configurable to FULL (OS/power-crash durable).
 *
 * Single shared DB per node. All agents share one file.
 */

import type {
  AgentManifest,
  EngineState,
  KoiError,
  PendingFrame,
  RecoveryPlan,
  Result,
  SessionFilter,
  SessionPersistence,
  SessionRecord,
  SkippedRecoveryEntry,
} from "@koi/core";
import { agentId, internal, notFound, sessionId, validateNonEmpty } from "@koi/core";
import { extractMessage } from "@koi/errors";
import { openDb } from "./open-db.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SessionStoreConfig {
  /** SQLite file path, or ":memory:" for tests. */
  readonly dbPath: string;
  /**
   * "process" — WAL + synchronous=NORMAL (survives process crashes, not power loss).
   * "os"      — WAL + synchronous=FULL  (survives OS crashes and power loss, slower).
   * Default: "process"
   */
  readonly durability?: "process" | "os";
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface SessionRow {
  readonly sessionId: string;
  readonly agentId: string;
  readonly manifest: string;
  readonly seq: number;
  readonly remoteSeq: number;
  readonly connectedAt: number;
  readonly lastPersistedAt: number;
  readonly lastEngineState: string | null;
  readonly metadata: string;
}

interface PendingFrameRow {
  readonly frameId: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly frameType: string;
  readonly payload: string;
  readonly orderIndex: number;
  readonly createdAt: number;
  readonly ttl: number | null;
  readonly retryCount: number;
}

// ---------------------------------------------------------------------------
// Row deserializers
// ---------------------------------------------------------------------------

function parseManifest(raw: string, sid: string): AgentManifest {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Invalid manifest for session ${sid}: not an object`);
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.name !== "string" || typeof obj.version !== "string") {
    throw new Error(`Invalid manifest for session ${sid}: missing name or version`);
  }
  return parsed as AgentManifest;
}

function parseMetadata(raw: string, sid: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new Error("not an object");
  } catch (e: unknown) {
    throw new Error(`Corrupt metadata JSON in session ${sid}: ${raw.slice(0, 100)}`, { cause: e });
  }
}

function parseEngineState(raw: string | null): EngineState | undefined {
  if (raw === null) return undefined;
  return JSON.parse(raw) as EngineState;
}

function rowToSessionRecord(row: SessionRow): SessionRecord {
  const base: SessionRecord = {
    sessionId: sessionId(row.sessionId),
    agentId: agentId(row.agentId),
    manifestSnapshot: parseManifest(row.manifest, row.sessionId),
    seq: row.seq,
    remoteSeq: row.remoteSeq,
    connectedAt: row.connectedAt,
    lastPersistedAt: row.lastPersistedAt,
    metadata: parseMetadata(row.metadata, row.sessionId),
  };
  const engineState = parseEngineState(row.lastEngineState);
  if (engineState !== undefined) {
    return { ...base, lastEngineState: engineState };
  }
  return base;
}

function rowToPendingFrame(row: PendingFrameRow): PendingFrame {
  return {
    frameId: row.frameId,
    sessionId: sessionId(row.sessionId),
    agentId: agentId(row.agentId),
    frameType: row.frameType,
    payload: JSON.parse(row.payload) as unknown,
    orderIndex: row.orderIndex,
    createdAt: row.createdAt,
    ttl: row.ttl ?? undefined,
    retryCount: row.retryCount,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSqliteSessionPersistence(
  config: SessionStoreConfig,
): SessionPersistence & { readonly close: () => void } {
  const db = openDb(config.dbPath, config.durability);

  // -- Schema (v2 clean — no v1 migration stubs) ----------------------------

  db.run(`
    CREATE TABLE IF NOT EXISTS _schema_version (v INTEGER NOT NULL);
  `);
  // Insert version 1 only if the table is empty (idempotent across restarts)
  db.run(
    "INSERT INTO _schema_version (v) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM _schema_version)",
  );

  db.run(`
    CREATE TABLE IF NOT EXISTS session_records (
      sessionId        TEXT PRIMARY KEY,
      agentId          TEXT NOT NULL,
      manifest         TEXT NOT NULL,
      seq              INTEGER NOT NULL DEFAULT 0,
      remoteSeq        INTEGER NOT NULL DEFAULT 0,
      connectedAt      INTEGER NOT NULL,
      lastPersistedAt  INTEGER NOT NULL,
      lastEngineState  TEXT,
      metadata         TEXT NOT NULL DEFAULT '{}'
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_sr_agentId ON session_records(agentId)");

  db.run(`
    CREATE TABLE IF NOT EXISTS pending_frames (
      frameId     TEXT PRIMARY KEY,
      sessionId   TEXT NOT NULL
                    REFERENCES session_records(sessionId) ON DELETE CASCADE,
      agentId     TEXT NOT NULL,
      frameType   TEXT NOT NULL,
      payload     TEXT NOT NULL,
      orderIndex  INTEGER NOT NULL,
      createdAt   INTEGER NOT NULL,
      ttl         INTEGER,
      retryCount  INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_pf_sessionId ON pending_frames(sessionId, orderIndex)");

  // -- Prepared statements (all at constructor time — decision 14-A) ---------

  const upsertSessionStmt = db.prepare(`
    INSERT INTO session_records
      (sessionId, agentId, manifest, seq, remoteSeq, connectedAt, lastPersistedAt, lastEngineState, metadata)
    VALUES
      ($sessionId, $agentId, $manifest, $seq, $remoteSeq, $connectedAt, $lastPersistedAt, $lastEngineState, $metadata)
    ON CONFLICT(sessionId) DO UPDATE SET
      agentId         = excluded.agentId,
      manifest        = excluded.manifest,
      seq             = excluded.seq,
      remoteSeq       = excluded.remoteSeq,
      lastPersistedAt = excluded.lastPersistedAt,
      lastEngineState = excluded.lastEngineState,
      metadata        = excluded.metadata
  `);

  const selectSessionStmt = db.query<SessionRow, [string]>(
    "SELECT * FROM session_records WHERE sessionId = ?",
  );

  const deleteSessionStmt = db.prepare("DELETE FROM session_records WHERE sessionId = ?");

  const lookupAgentForSessionStmt = db.query<{ readonly agentId: string }, [string]>(
    "SELECT agentId FROM session_records WHERE sessionId = ?",
  );

  const selectAllSessionsStmt = db.query<SessionRow, []>("SELECT * FROM session_records");

  const selectSessionsByAgentStmt = db.query<SessionRow, [string]>(
    "SELECT * FROM session_records WHERE agentId = ?",
  );

  const upsertPendingFrameStmt = db.prepare(`
    INSERT INTO pending_frames
      (frameId, sessionId, agentId, frameType, payload, orderIndex, createdAt, ttl, retryCount)
    VALUES
      ($frameId, $sessionId, $agentId, $frameType, $payload, $orderIndex, $createdAt, $ttl, $retryCount)
    ON CONFLICT(frameId) DO UPDATE SET
      retryCount = excluded.retryCount,
      payload    = excluded.payload
  `);

  const deleteSingleFrameStmt = db.prepare("DELETE FROM pending_frames WHERE frameId = ?");

  const selectPendingFramesStmt = db.query<PendingFrameRow, [string]>(
    "SELECT * FROM pending_frames WHERE sessionId = ? ORDER BY orderIndex ASC",
  );

  const deletePendingFramesStmt = db.prepare("DELETE FROM pending_frames WHERE sessionId = ?");

  // Batch fetch all frames — avoids N+1 when recovering many sessions (decision 13-A)
  const selectAllPendingFramesStmt = db.query<PendingFrameRow, []>(
    "SELECT * FROM pending_frames ORDER BY sessionId, orderIndex ASC",
  );

  // -- Implementation -------------------------------------------------------

  const saveSession = (record: SessionRecord): Result<void, KoiError> => {
    // SQLite stores IDs as TEXT — no filesystem path encoding needed.
    // Use non-empty check only; path-safety is a JSONL-store concern.
    const idCheck = validateNonEmpty(record.sessionId, "Session ID");
    if (!idCheck.ok) return idCheck;
    const agentCheck = validateNonEmpty(record.agentId, "Agent ID");
    if (!agentCheck.ok) return agentCheck;

    try {
      upsertSessionStmt.run({
        $sessionId: record.sessionId,
        $agentId: record.agentId,
        $manifest: JSON.stringify(record.manifestSnapshot),
        $seq: record.seq,
        $remoteSeq: record.remoteSeq,
        $connectedAt: record.connectedAt,
        $lastPersistedAt: record.lastPersistedAt,
        $lastEngineState:
          record.lastEngineState !== undefined ? JSON.stringify(record.lastEngineState) : null,
        $metadata: JSON.stringify(record.metadata),
      });
      return { ok: true, value: undefined };
    } catch (e: unknown) {
      return { ok: false, error: internal("Failed to save session record", e) };
    }
  };

  const loadSession = (sid: string): Result<SessionRecord, KoiError> => {
    const idCheck = validateNonEmpty(sid, "Session ID");
    if (!idCheck.ok) return idCheck;

    try {
      const row = selectSessionStmt.get(sid);
      if (row === null) {
        return { ok: false, error: notFound(sid, `Session not found: ${sid}`) };
      }
      return { ok: true, value: rowToSessionRecord(row) };
    } catch (e: unknown) {
      return { ok: false, error: internal("Failed to load session record", e) };
    }
  };

  const removeSession = (sid: string): Result<void, KoiError> => {
    const idCheck = validateNonEmpty(sid, "Session ID");
    if (!idCheck.ok) return idCheck;

    try {
      const agentRow = lookupAgentForSessionStmt.get(sid);
      if (agentRow === null) {
        return { ok: false, error: notFound(sid, `Session not found: ${sid}`) };
      }
      // Atomic cascade: delete frames then session in one transaction
      db.transaction(() => {
        deletePendingFramesStmt.run(sid);
        deleteSessionStmt.run(sid);
      })();
      return { ok: true, value: undefined };
    } catch (e: unknown) {
      return { ok: false, error: internal("Failed to remove session", e) };
    }
  };

  const listSessions = (filter?: SessionFilter): Result<readonly SessionRecord[], KoiError> => {
    try {
      let rows: readonly SessionRow[];
      if (filter?.agentId !== undefined) {
        rows = selectSessionsByAgentStmt.all(filter.agentId);
      } else {
        rows = selectAllSessionsStmt.all();
      }
      return { ok: true, value: rows.map(rowToSessionRecord) };
    } catch (e: unknown) {
      return { ok: false, error: internal("Failed to list sessions", e) };
    }
  };

  const savePendingFrame = (frame: PendingFrame): Result<void, KoiError> => {
    const idCheck = validateNonEmpty(frame.frameId, "Frame ID");
    if (!idCheck.ok) return idCheck;
    const sessionCheck = validateNonEmpty(frame.sessionId, "Session ID");
    if (!sessionCheck.ok) return sessionCheck;

    try {
      upsertPendingFrameStmt.run({
        $frameId: frame.frameId,
        $sessionId: frame.sessionId,
        $agentId: frame.agentId,
        $frameType: frame.frameType,
        $payload: JSON.stringify(frame.payload),
        $orderIndex: frame.orderIndex,
        $createdAt: frame.createdAt,
        $ttl: frame.ttl ?? null,
        $retryCount: frame.retryCount,
      });
      return { ok: true, value: undefined };
    } catch (e: unknown) {
      return { ok: false, error: internal("Failed to save pending frame", e) };
    }
  };

  const loadPendingFrames = (sid: string): Result<readonly PendingFrame[], KoiError> => {
    const idCheck = validateNonEmpty(sid, "Session ID");
    if (!idCheck.ok) return idCheck;

    try {
      const rows = selectPendingFramesStmt.all(sid);
      return { ok: true, value: rows.map(rowToPendingFrame) };
    } catch (e: unknown) {
      return { ok: false, error: internal("Failed to load pending frames", e) };
    }
  };

  const clearPendingFrames = (sid: string): Result<void, KoiError> => {
    const idCheck = validateNonEmpty(sid, "Session ID");
    if (!idCheck.ok) return idCheck;

    try {
      deletePendingFramesStmt.run(sid);
      return { ok: true, value: undefined };
    } catch (e: unknown) {
      return { ok: false, error: internal("Failed to clear pending frames", e) };
    }
  };

  const removePendingFrame = (frameId: string): Result<void, KoiError> => {
    const idCheck = validateNonEmpty(frameId, "Frame ID");
    if (!idCheck.ok) return idCheck;

    try {
      deleteSingleFrameStmt.run(frameId);
      return { ok: true, value: undefined };
    } catch (e: unknown) {
      return { ok: false, error: internal("Failed to remove pending frame", e) };
    }
  };

  const recover = (): Result<RecoveryPlan, KoiError> => {
    try {
      return db.transaction((): Result<RecoveryPlan, KoiError> => {
        const skipped: SkippedRecoveryEntry[] = [];

        // Per-row error isolation for sessions
        const sessionRows = selectAllSessionsStmt.all();
        const sessions: SessionRecord[] = [];
        for (const row of sessionRows) {
          try {
            sessions.push(rowToSessionRecord(row));
          } catch (e: unknown) {
            skipped.push({ source: "session", id: row.sessionId, error: extractMessage(e) });
          }
        }

        // Build the set of successfully recovered session IDs so pending frames
        // can be filtered to only those whose session is known-good.
        const recoveredIds = new Set(sessions.map((s) => s.sessionId));

        // Batch load all pending frames (one query, no N+1) — decision 13-A
        // Frames for sessions that failed to recover are moved to skipped to
        // prevent replaying outbound messages into non-existent/corrupt sessions.
        const pendingFrames = new Map<string, PendingFrame[]>();
        const allFrameRows = selectAllPendingFramesStmt.all();
        for (const row of allFrameRows) {
          try {
            const frame = rowToPendingFrame(row);
            if (!recoveredIds.has(row.sessionId)) {
              skipped.push({
                source: "pending_frame",
                id: row.frameId,
                error: `Orphan frame: session ${row.sessionId} was not recovered`,
              });
              continue;
            }
            const existing = pendingFrames.get(row.sessionId);
            if (existing !== undefined) {
              existing.push(frame);
            } else {
              pendingFrames.set(row.sessionId, [frame]);
            }
          } catch (e: unknown) {
            skipped.push({ source: "pending_frame", id: row.frameId, error: extractMessage(e) });
          }
        }

        return { ok: true, value: { sessions, pendingFrames, skipped } };
      })();
    } catch (e: unknown) {
      return { ok: false, error: internal("Failed to recover sessions", e) };
    }
  };

  const close = (): void => {
    db.close();
  };

  return {
    saveSession,
    loadSession,
    removeSession,
    listSessions,
    savePendingFrame,
    loadPendingFrames,
    clearPendingFrames,
    removePendingFrame,
    recover,
    close,
  };
}
