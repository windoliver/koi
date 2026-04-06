/**
 * SqliteSessionPersistence — bun:sqlite backend for durable session storage.
 *
 * WAL mode for crash durability. synchronous=NORMAL by default (process-crash
 * durable), configurable to FULL (OS/power-crash durable). fullfsync=1 on macOS
 * when durability="os" (F_FULLFSYNC required for true power-loss safety).
 *
 * Single shared DB per node. All agents share one file.
 *
 * Schema version: 2
 *   v1 → v2: added status column to session_records, content_replacements table.
 */

import type {
  AgentManifest,
  ContentReplacement,
  EngineState,
  KoiError,
  PendingFrame,
  RecoveryPlan,
  Result,
  SessionFilter,
  SessionPersistence,
  SessionRecord,
  SessionStatus,
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
   * "os"      — WAL + synchronous=FULL + fullfsync=1 on macOS (power-loss safe, slower).
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
  readonly status: string;
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

interface ContentReplacementRow {
  readonly session_id: string;
  readonly message_id: string;
  readonly file_path: string;
  readonly byte_count: number;
  readonly replaced_at: number;
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

function isEngineState(v: unknown): v is EngineState {
  return (
    typeof v === "object" &&
    v !== null &&
    "engineId" in v &&
    typeof (v as Record<string, unknown>).engineId === "string" &&
    "data" in v
  );
}

function parseEngineState(raw: string | null): EngineState | undefined {
  if (raw === null) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (!isEngineState(parsed)) {
    throw new Error(`Invalid EngineState: missing engineId or data field`);
  }
  return parsed;
}

function parseStatus(raw: string, sid: string): SessionStatus {
  if (raw === "running" || raw === "idle" || raw === "done") return raw;
  throw new Error(`Invalid status "${raw}" for session ${sid}: must be running|idle|done`);
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
    status: parseStatus(row.status, row.sessionId),
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

function rowToContentReplacement(row: ContentReplacementRow): ContentReplacement {
  return {
    sessionId: sessionId(row.session_id),
    messageId: row.message_id,
    filePath: row.file_path,
    byteCount: row.byte_count,
    replacedAt: row.replaced_at,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSqliteSessionPersistence(
  config: SessionStoreConfig,
): SessionPersistence & { readonly close: () => void } {
  const db = openDb(config.dbPath, config.durability);

  // -- Schema init + migration (version-gated, idempotent) ------------------

  db.run(`CREATE TABLE IF NOT EXISTS _schema_version (v INTEGER NOT NULL)`);
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
      metadata         TEXT NOT NULL DEFAULT '{}',
      status           TEXT NOT NULL DEFAULT 'idle'
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

  db.run(`
    CREATE TABLE IF NOT EXISTS content_replacements (
      session_id  TEXT NOT NULL
                    REFERENCES session_records(sessionId) ON DELETE CASCADE,
      message_id  TEXT NOT NULL,
      file_path   TEXT NOT NULL,
      byte_count  INTEGER NOT NULL,
      replaced_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, message_id)
    )
  `);

  // v1 → v2 migration: add status column + content_replacements table to existing DBs.
  // ALTER TABLE ADD COLUMN with DEFAULT is instant in SQLite (no table rewrite).
  const currentVersion =
    db.query<{ v: number }, []>("SELECT v FROM _schema_version LIMIT 1").get()?.v ?? 0;
  if (currentVersion < 2) {
    try {
      db.run("ALTER TABLE session_records ADD COLUMN status TEXT NOT NULL DEFAULT 'idle'");
    } catch {
      // Column already exists (e.g. fresh DB created above) — safe to ignore
    }
    db.run("UPDATE _schema_version SET v = 2");
  }

  // -- Private sync helper — eliminates 9 identical try/catch blocks (decision 7-A)

  function runSync<T>(context: string, fn: () => T): Result<T, KoiError> {
    try {
      return { ok: true, value: fn() };
    } catch (e: unknown) {
      return { ok: false, error: internal(context, e) };
    }
  }

  // -- Prepared statements (all at constructor time — decision 14-A) ---------

  const upsertSessionStmt = db.prepare(`
    INSERT INTO session_records
      (sessionId, agentId, manifest, seq, remoteSeq, connectedAt, lastPersistedAt, lastEngineState, metadata, status)
    VALUES
      ($sessionId, $agentId, $manifest, $seq, $remoteSeq, $connectedAt, $lastPersistedAt, $lastEngineState, $metadata, $status)
    ON CONFLICT(sessionId) DO UPDATE SET
      agentId         = excluded.agentId,
      manifest        = excluded.manifest,
      seq             = excluded.seq,
      remoteSeq       = excluded.remoteSeq,
      lastPersistedAt = excluded.lastPersistedAt,
      lastEngineState = excluded.lastEngineState,
      metadata        = excluded.metadata,
      status          = excluded.status
  `);

  const updateStatusStmt = db.prepare(
    "UPDATE session_records SET status = $status WHERE sessionId = $sessionId",
  );

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
      agentId    = excluded.agentId,
      frameType  = excluded.frameType,
      payload    = excluded.payload,
      orderIndex = excluded.orderIndex,
      createdAt  = excluded.createdAt,
      ttl        = excluded.ttl,
      retryCount = excluded.retryCount
  `);

  const deleteSingleFrameStmt = db.prepare("DELETE FROM pending_frames WHERE frameId = ?");

  const selectPendingFramesStmt = db.query<PendingFrameRow, [string]>(
    "SELECT * FROM pending_frames WHERE sessionId = ? ORDER BY orderIndex ASC",
  );

  const deletePendingFramesStmt = db.prepare("DELETE FROM pending_frames WHERE sessionId = ?");

  const selectAllPendingFramesStmt = db.query<PendingFrameRow, []>(
    "SELECT * FROM pending_frames ORDER BY sessionId, orderIndex ASC",
  );

  const upsertContentReplacementStmt = db.prepare(`
    INSERT INTO content_replacements (session_id, message_id, file_path, byte_count, replaced_at)
    VALUES ($session_id, $message_id, $file_path, $byte_count, $replaced_at)
    ON CONFLICT(session_id, message_id) DO UPDATE SET
      file_path   = excluded.file_path,
      byte_count  = excluded.byte_count,
      replaced_at = excluded.replaced_at
  `);

  const selectContentReplacementsStmt = db.query<ContentReplacementRow, [string]>(
    "SELECT * FROM content_replacements WHERE session_id = ?",
  );

  // -- Implementation -------------------------------------------------------

  const saveSession = (record: SessionRecord): Result<void, KoiError> => {
    const idCheck = validateNonEmpty(record.sessionId, "Session ID");
    if (!idCheck.ok) return idCheck;
    const agentCheck = validateNonEmpty(record.agentId, "Agent ID");
    if (!agentCheck.ok) return agentCheck;

    return runSync("Failed to save session record", () => {
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
        $status: record.status,
      });
    });
  };

  const loadSession = (sid: string): Result<SessionRecord, KoiError> => {
    const idCheck = validateNonEmpty(sid, "Session ID");
    if (!idCheck.ok) return idCheck;

    // Two-step: query first (DB errors → INTERNAL), then check existence outside
    // runSync so NOT_FOUND error code is preserved (throw inside runSync becomes INTERNAL).
    const queryResult = runSync("Failed to query session record", () => selectSessionStmt.get(sid));
    if (!queryResult.ok) return queryResult;
    const row = queryResult.value;
    if (row === null) {
      return { ok: false, error: notFound(sid, `Session not found: ${sid}`) };
    }
    return runSync("Failed to parse session record", () => rowToSessionRecord(row));
  };

  const removeSession = (sid: string): Result<void, KoiError> => {
    const idCheck = validateNonEmpty(sid, "Session ID");
    if (!idCheck.ok) return idCheck;

    // Look up existence first — NOT_FOUND check must be outside runSync.
    const lookupResult = runSync("Failed to look up session", () =>
      lookupAgentForSessionStmt.get(sid),
    );
    if (!lookupResult.ok) return lookupResult;
    if (lookupResult.value === null) {
      return { ok: false, error: notFound(sid, `Session not found: ${sid}`) };
    }
    // Atomic cascade: delete frames then session in one transaction
    return runSync("Failed to remove session", () => {
      db.transaction(() => {
        deletePendingFramesStmt.run(sid);
        deleteSessionStmt.run(sid);
      })();
    });
  };

  const listSessions = (filter?: SessionFilter): Result<readonly SessionRecord[], KoiError> => {
    return runSync("Failed to list sessions", () => {
      let rows: readonly SessionRow[];
      if (filter?.agentId !== undefined) {
        rows = selectSessionsByAgentStmt.all(filter.agentId);
      } else {
        rows = selectAllSessionsStmt.all();
      }
      return rows.map(rowToSessionRecord);
    });
  };

  const savePendingFrame = (frame: PendingFrame): Result<void, KoiError> => {
    const idCheck = validateNonEmpty(frame.frameId, "Frame ID");
    if (!idCheck.ok) return idCheck;
    const sessionCheck = validateNonEmpty(frame.sessionId, "Session ID");
    if (!sessionCheck.ok) return sessionCheck;

    return runSync("Failed to save pending frame", () => {
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
    });
  };

  const loadPendingFrames = (sid: string): Result<readonly PendingFrame[], KoiError> => {
    const idCheck = validateNonEmpty(sid, "Session ID");
    if (!idCheck.ok) return idCheck;

    return runSync("Failed to load pending frames", () =>
      selectPendingFramesStmt.all(sid).map(rowToPendingFrame),
    );
  };

  const clearPendingFrames = (sid: string): Result<void, KoiError> => {
    const idCheck = validateNonEmpty(sid, "Session ID");
    if (!idCheck.ok) return idCheck;

    return runSync("Failed to clear pending frames", () => {
      deletePendingFramesStmt.run(sid);
    });
  };

  const removePendingFrame = (frameId: string): Result<void, KoiError> => {
    const idCheck = validateNonEmpty(frameId, "Frame ID");
    if (!idCheck.ok) return idCheck;

    return runSync("Failed to remove pending frame", () => {
      deleteSingleFrameStmt.run(frameId);
    });
  };

  const setSessionStatus = (sid: string, status: SessionStatus): Result<void, KoiError> => {
    const idCheck = validateNonEmpty(sid, "Session ID");
    if (!idCheck.ok) return idCheck;

    // Run update, then check changes count outside runSync for NOT_FOUND.
    const result = runSync("Failed to set session status", () =>
      updateStatusStmt.run({ $status: status, $sessionId: sid }),
    );
    if (!result.ok) return result;
    if (result.value.changes === 0) {
      return { ok: false, error: notFound(sid, `Session not found: ${sid}`) };
    }
    return { ok: true, value: undefined };
  };

  const saveContentReplacement = (record: ContentReplacement): Result<void, KoiError> => {
    const idCheck = validateNonEmpty(record.sessionId, "Session ID");
    if (!idCheck.ok) return idCheck;
    const msgCheck = validateNonEmpty(record.messageId, "Message ID");
    if (!msgCheck.ok) return msgCheck;

    return runSync("Failed to save content replacement", () => {
      upsertContentReplacementStmt.run({
        $session_id: record.sessionId,
        $message_id: record.messageId,
        $file_path: record.filePath,
        $byte_count: record.byteCount,
        $replaced_at: record.replacedAt,
      });
    });
  };

  const loadContentReplacements = (
    sid: string,
  ): Result<readonly ContentReplacement[], KoiError> => {
    const idCheck = validateNonEmpty(sid, "Session ID");
    if (!idCheck.ok) return idCheck;

    return runSync("Failed to load content replacements", () =>
      selectContentReplacementsStmt.all(sid).map(rowToContentReplacement),
    );
  };

  const recover = (): Result<RecoveryPlan, KoiError> => {
    return runSync("Failed to recover sessions", () =>
      db.transaction((): RecoveryPlan => {
        const skipped: SkippedRecoveryEntry[] = [];

        const sessionRows = selectAllSessionsStmt.all();
        const sessions: SessionRecord[] = [];
        for (const row of sessionRows) {
          try {
            sessions.push(rowToSessionRecord(row));
          } catch (e: unknown) {
            skipped.push({ source: "session", id: row.sessionId, error: extractMessage(e) });
          }
        }

        const recoveredIds = new Set(sessions.map((s) => String(s.sessionId)));

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

        return { sessions, pendingFrames, skipped };
      })(),
    );
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
    setSessionStatus,
    saveContentReplacement,
    loadContentReplacements,
    recover,
    close,
  };
}
