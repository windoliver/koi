/**
 * SqliteSessionPersistence — bun:sqlite backend for durable session storage.
 *
 * WAL mode for crash durability. synchronous=NORMAL by default (process-crash
 * durable), configurable to FULL (OS/power-crash durable).
 *
 * Single shared DB per node. All agents share one file.
 * Checkpoint retention: keeps latest N per agent, prunes oldest on save.
 */

import type {
  AgentId,
  AgentManifest,
  KoiError,
  PendingFrame,
  ProcessState,
  RecoveryPlan,
  Result,
  SessionCheckpoint,
  SessionFilter,
  SessionPersistence,
  SessionRecord,
  SkippedRecoveryEntry,
} from "@koi/core";
import {
  agentId,
  internal,
  isProcessState,
  notFound,
  sessionId,
  validateNonEmpty,
} from "@koi/core";
import { extractMessage } from "@koi/errors";
import { openDb } from "@koi/sqlite-utils";
import type { SessionStoreConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CHECKPOINTS = 3;

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
  readonly lastCheckpointAt: number;
  readonly metadata: string;
}

interface CheckpointRow {
  readonly id: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly engineState: string;
  readonly processState: string;
  readonly generation: number;
  readonly metadata: string;
  readonly createdAt: number;
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
// Helpers
// ---------------------------------------------------------------------------

function parseJson(raw: string, label: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new Error("not an object");
  } catch (e: unknown) {
    throw new Error(`Corrupt JSON in ${label}: ${raw.slice(0, 100)}`, { cause: e });
  }
}

function parseManifest(raw: string, sessionId: string): AgentManifest {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Invalid manifest for session ${sessionId}: not an object`);
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.name !== "string" || typeof obj.version !== "string") {
    throw new Error(`Invalid manifest for session ${sessionId}: missing name or version`);
  }
  return parsed as AgentManifest;
}

function parseProcessState(raw: string, contextId: string): ProcessState {
  if (!isProcessState(raw)) {
    throw new Error(`Invalid processState "${raw}" for checkpoint ${contextId}`);
  }
  return raw;
}

function rowToSessionRecord(row: SessionRow): SessionRecord {
  return {
    sessionId: sessionId(row.sessionId),
    agentId: agentId(row.agentId),
    manifestSnapshot: parseManifest(row.manifest, row.sessionId),
    seq: row.seq,
    remoteSeq: row.remoteSeq,
    connectedAt: row.connectedAt,
    lastCheckpointAt: row.lastCheckpointAt,
    metadata: parseJson(row.metadata, `session ${row.sessionId}`),
  };
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

function rowToCheckpoint(row: CheckpointRow): SessionCheckpoint {
  const engineState: { readonly engineId: string; readonly data: unknown } = JSON.parse(
    row.engineState,
  ) as { engineId: string; data: unknown };
  return {
    id: row.id,
    agentId: agentId(row.agentId),
    sessionId: sessionId(row.sessionId),
    engineState,
    processState: parseProcessState(row.processState, row.id),
    generation: row.generation,
    metadata: parseJson(row.metadata, `checkpoint ${row.id}`),
    createdAt: row.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createSqliteSessionPersistence(
  config: SessionStoreConfig,
): SessionPersistence & { readonly close: () => void } {
  const maxCheckpoints = config.maxCheckpointsPerAgent ?? DEFAULT_MAX_CHECKPOINTS;
  const db = openDb(config.dbPath);

  // Override synchronous if "os" durability requested
  if (config.durability === "os") {
    db.run("PRAGMA synchronous = FULL");
  }

  // -- Schema --------------------------------------------------------------
  db.run(`
    CREATE TABLE IF NOT EXISTS session_records (
      sessionId        TEXT PRIMARY KEY,
      agentId          TEXT NOT NULL,
      manifest         TEXT NOT NULL,
      seq              INTEGER NOT NULL DEFAULT 0,
      remoteSeq        INTEGER NOT NULL DEFAULT 0,
      connectedAt      INTEGER NOT NULL,
      lastCheckpointAt INTEGER NOT NULL,
      metadata         TEXT NOT NULL DEFAULT '{}'
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_sr_agentId ON session_records(agentId)");

  db.run(`
    CREATE TABLE IF NOT EXISTS checkpoints (
      id            TEXT PRIMARY KEY,
      agentId       TEXT NOT NULL,
      sessionId     TEXT NOT NULL,
      engineState   TEXT NOT NULL,
      processState  TEXT NOT NULL,
      generation    INTEGER NOT NULL,
      metadata      TEXT NOT NULL DEFAULT '{}',
      createdAt     INTEGER NOT NULL
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_cp_agentId ON checkpoints(agentId)");
  db.run("CREATE INDEX IF NOT EXISTS idx_cp_createdAt ON checkpoints(createdAt)");

  db.run(`
    CREATE TABLE IF NOT EXISTS pending_frames (
      frameId     TEXT PRIMARY KEY,
      sessionId   TEXT NOT NULL,
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

  // -- Prepared statements -------------------------------------------------
  const upsertSessionStmt = db.prepare(`
    INSERT INTO session_records (sessionId, agentId, manifest, seq, remoteSeq, connectedAt, lastCheckpointAt, metadata)
    VALUES ($sessionId, $agentId, $manifest, $seq, $remoteSeq, $connectedAt, $lastCheckpointAt, $metadata)
    ON CONFLICT(sessionId) DO UPDATE SET
      agentId = excluded.agentId,
      manifest = excluded.manifest,
      seq = excluded.seq,
      remoteSeq = excluded.remoteSeq,
      lastCheckpointAt = excluded.lastCheckpointAt,
      metadata = excluded.metadata
  `);

  const selectSessionStmt = db.query<SessionRow, [string]>(
    "SELECT * FROM session_records WHERE sessionId = ?",
  );

  const deleteSessionStmt = db.prepare("DELETE FROM session_records WHERE sessionId = ?");

  const deleteCheckpointsByAgentStmt = db.prepare("DELETE FROM checkpoints WHERE agentId = ?");

  const insertCheckpointStmt = db.prepare(`
    INSERT INTO checkpoints (id, agentId, sessionId, engineState, processState, generation, metadata, createdAt)
    VALUES ($id, $agentId, $sessionId, $engineState, $processState, $generation, $metadata, $createdAt)
  `);

  const selectLatestCheckpointStmt = db.query<CheckpointRow, [string]>(
    "SELECT * FROM checkpoints WHERE agentId = ? ORDER BY createdAt DESC LIMIT 1",
  );

  const selectCheckpointsByAgentStmt = db.query<CheckpointRow, [string]>(
    "SELECT * FROM checkpoints WHERE agentId = ? ORDER BY createdAt DESC",
  );

  const selectAllSessionsStmt = db.query<SessionRow, []>("SELECT * FROM session_records");

  const selectSessionsByAgentStmt = db.query<SessionRow, [string]>(
    "SELECT * FROM session_records WHERE agentId = ?",
  );

  const lookupAgentForSessionStmt = db.query<{ readonly agentId: string }, [string]>(
    "SELECT agentId FROM session_records WHERE sessionId = ?",
  );

  const upsertPendingFrameStmt = db.prepare(`
    INSERT INTO pending_frames (frameId, sessionId, agentId, frameType, payload, orderIndex, createdAt, ttl, retryCount)
    VALUES ($frameId, $sessionId, $agentId, $frameType, $payload, $orderIndex, $createdAt, $ttl, $retryCount)
    ON CONFLICT(frameId) DO UPDATE SET
      retryCount = excluded.retryCount,
      payload = excluded.payload
  `);

  const deleteSingleFrameStmt = db.prepare("DELETE FROM pending_frames WHERE frameId = ?");

  const selectPendingFramesStmt = db.query<PendingFrameRow, [string]>(
    "SELECT * FROM pending_frames WHERE sessionId = ? ORDER BY orderIndex ASC",
  );

  const deletePendingFramesStmt = db.prepare("DELETE FROM pending_frames WHERE sessionId = ?");

  const deletePendingFramesByAgentStmt = db.prepare("DELETE FROM pending_frames WHERE agentId = ?");

  const pruneCheckpointsStmt = db.prepare(`
    DELETE FROM checkpoints WHERE agentId = ? AND id NOT IN (
      SELECT id FROM checkpoints WHERE agentId = ? ORDER BY createdAt DESC LIMIT ?
    )
  `);

  // N+1 fix: batch-fetch latest checkpoint per agent and all pending frames
  const selectLatestCheckpointsAllStmt = db.query<CheckpointRow, []>(`
    SELECT c.* FROM checkpoints c
    INNER JOIN (
      SELECT agentId, MAX(createdAt) AS maxCreated FROM checkpoints GROUP BY agentId
    ) latest ON c.agentId = latest.agentId AND c.createdAt = latest.maxCreated
  `);

  const selectAllPendingFramesStmt = db.query<PendingFrameRow, []>(
    "SELECT * FROM pending_frames ORDER BY sessionId, orderIndex ASC",
  );

  // -- SessionPersistence implementation -----------------------------------

  const saveSession = (record: SessionRecord): Result<void, KoiError> => {
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
        $lastCheckpointAt: record.lastCheckpointAt,
        $metadata: JSON.stringify(record.metadata),
      });
      return { ok: true, value: undefined };
    } catch (e: unknown) {
      return { ok: false, error: internal("Failed to save session record", e) };
    }
  };

  const loadSession = (sessionId: string): Result<SessionRecord, KoiError> => {
    const idCheck = validateNonEmpty(sessionId, "Session ID");
    if (!idCheck.ok) return idCheck;

    try {
      const row = selectSessionStmt.get(sessionId);
      if (row === null) {
        return { ok: false, error: notFound(sessionId, `Session not found: ${sessionId}`) };
      }
      return { ok: true, value: rowToSessionRecord(row) };
    } catch (e: unknown) {
      return { ok: false, error: internal("Failed to load session record", e) };
    }
  };

  const removeSession = (sessionId: string): Result<void, KoiError> => {
    const idCheck = validateNonEmpty(sessionId, "Session ID");
    if (!idCheck.ok) return idCheck;

    try {
      // Look up agent ID to also remove checkpoints
      const agentRow = lookupAgentForSessionStmt.get(sessionId);
      if (agentRow === null) {
        return { ok: false, error: notFound(sessionId, `Session not found: ${sessionId}`) };
      }

      db.transaction(() => {
        deleteCheckpointsByAgentStmt.run(agentRow.agentId);
        deletePendingFramesByAgentStmt.run(agentRow.agentId);
        deleteSessionStmt.run(sessionId);
      })();

      return { ok: true, value: undefined };
    } catch (e: unknown) {
      return { ok: false, error: internal("Failed to remove session", e) };
    }
  };

  // N+1: processState filter issues one checkpoint query per session row.
  // Acceptable for small session counts on edge devices; revisit if > 1000 sessions.
  const listSessions = (filter?: SessionFilter): Result<readonly SessionRecord[], KoiError> => {
    try {
      let rows: readonly SessionRow[];
      if (filter?.agentId !== undefined) {
        rows = selectSessionsByAgentStmt.all(filter.agentId);
      } else {
        rows = selectAllSessionsStmt.all();
      }

      let records = rows.map(rowToSessionRecord);

      // Post-filter by processState if requested (requires checking checkpoints)
      if (filter?.processState !== undefined) {
        const targetState = filter.processState;
        records = records.filter((r) => {
          const cpRow = selectLatestCheckpointStmt.get(r.agentId);
          return cpRow !== null && cpRow.processState === targetState;
        });
      }

      return { ok: true, value: records };
    } catch (e: unknown) {
      return { ok: false, error: internal("Failed to list sessions", e) };
    }
  };

  const saveCheckpoint = (checkpoint: SessionCheckpoint): Result<void, KoiError> => {
    const idCheck = validateNonEmpty(checkpoint.id, "Checkpoint ID");
    if (!idCheck.ok) return idCheck;
    const agentCheck = validateNonEmpty(checkpoint.agentId, "Agent ID");
    if (!agentCheck.ok) return agentCheck;

    try {
      db.transaction(() => {
        insertCheckpointStmt.run({
          $id: checkpoint.id,
          $agentId: checkpoint.agentId,
          $sessionId: checkpoint.sessionId,
          $engineState: JSON.stringify(checkpoint.engineState),
          $processState: checkpoint.processState,
          $generation: checkpoint.generation,
          $metadata: JSON.stringify(checkpoint.metadata),
          $createdAt: checkpoint.createdAt,
        });

        // Prune oldest checkpoints beyond retention limit
        pruneCheckpointsStmt.run(checkpoint.agentId, checkpoint.agentId, maxCheckpoints);
      })();

      return { ok: true, value: undefined };
    } catch (e: unknown) {
      return { ok: false, error: internal("Failed to save checkpoint", e) };
    }
  };

  const loadLatestCheckpoint = (aid: AgentId): Result<SessionCheckpoint | undefined, KoiError> => {
    const agentCheck = validateNonEmpty(aid, "Agent ID");
    if (!agentCheck.ok) return agentCheck;

    try {
      const row = selectLatestCheckpointStmt.get(aid);
      return { ok: true, value: row !== null ? rowToCheckpoint(row) : undefined };
    } catch (e: unknown) {
      return { ok: false, error: internal("Failed to load checkpoint", e) };
    }
  };

  const listCheckpoints = (aid: AgentId): Result<readonly SessionCheckpoint[], KoiError> => {
    const agentCheck = validateNonEmpty(aid, "Agent ID");
    if (!agentCheck.ok) return agentCheck;

    try {
      const rows = selectCheckpointsByAgentStmt.all(aid);
      return { ok: true, value: rows.map(rowToCheckpoint) };
    } catch (e: unknown) {
      return { ok: false, error: internal("Failed to list checkpoints", e) };
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

  const loadPendingFrames = (sessionId: string): Result<readonly PendingFrame[], KoiError> => {
    const idCheck = validateNonEmpty(sessionId, "Session ID");
    if (!idCheck.ok) return idCheck;

    try {
      const rows = selectPendingFramesStmt.all(sessionId);
      return { ok: true, value: rows.map(rowToPendingFrame) };
    } catch (e: unknown) {
      return { ok: false, error: internal("Failed to load pending frames", e) };
    }
  };

  const clearPendingFrames = (sessionId: string): Result<void, KoiError> => {
    const idCheck = validateNonEmpty(sessionId, "Session ID");
    if (!idCheck.ok) return idCheck;

    try {
      deletePendingFramesStmt.run(sessionId);
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
      return db.transaction(() => {
        const skipped: SkippedRecoveryEntry[] = [];

        // Batch-fetch sessions with per-row error isolation
        const sessionRows = selectAllSessionsStmt.all();
        const sessions: SessionRecord[] = [];
        for (const row of sessionRows) {
          try {
            sessions.push(rowToSessionRecord(row));
          } catch (e: unknown) {
            skipped.push({
              source: "session",
              id: row.sessionId,
              error: extractMessage(e),
            });
          }
        }

        // Batch-fetch latest checkpoint per agent (N+1 fix)
        const checkpointMap = new Map<string, SessionCheckpoint>();
        const cpRows = selectLatestCheckpointsAllStmt.all();
        for (const row of cpRows) {
          try {
            checkpointMap.set(row.agentId, rowToCheckpoint(row));
          } catch (e: unknown) {
            skipped.push({
              source: "checkpoint",
              id: row.id,
              error: extractMessage(e),
            });
          }
        }

        // Batch-fetch all pending frames (N+1 fix)
        const pendingFrames = new Map<string, PendingFrame[]>();
        const allFrameRows = selectAllPendingFramesStmt.all();
        for (const row of allFrameRows) {
          try {
            const frame = rowToPendingFrame(row);
            const existing = pendingFrames.get(row.sessionId);
            if (existing !== undefined) {
              existing.push(frame);
            } else {
              pendingFrames.set(row.sessionId, [frame]);
            }
          } catch (e: unknown) {
            skipped.push({
              source: "pending_frame",
              id: row.frameId,
              error: extractMessage(e),
            });
          }
        }

        return {
          ok: true as const,
          value: { sessions, checkpoints: checkpointMap, pendingFrames, skipped },
        };
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
    saveCheckpoint,
    loadLatestCheckpoint,
    listCheckpoints,
    savePendingFrame,
    loadPendingFrames,
    clearPendingFrames,
    removePendingFrame,
    recover,
    close,
  };
}
