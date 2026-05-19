import type {
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
} from "@koi/core";
import { conflict, notFound, validateNonEmpty } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import { deletePath, listFilePaths, readJson, writeJson } from "./json-io.js";
import { contentReplacementPath, pendingFramePath, sessionRecordPath } from "./paths.js";

const locks = new Map<string, Promise<void>>();

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release = (): void => {};
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(key, next);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === next) locks.delete(key);
  }
}

function isSessionRecord(value: unknown): value is SessionRecord {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.sessionId === "string" &&
    typeof obj.agentId === "string" &&
    typeof obj.seq === "number" &&
    typeof obj.remoteSeq === "number" &&
    typeof obj.connectedAt === "number" &&
    typeof obj.lastPersistedAt === "number" &&
    (obj.status === "running" || obj.status === "idle" || obj.status === "done") &&
    typeof obj.metadata === "object" &&
    obj.metadata !== null
  );
}

function isPendingFrame(value: unknown): value is PendingFrame {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.frameId === "string" &&
    typeof obj.sessionId === "string" &&
    typeof obj.agentId === "string" &&
    typeof obj.frameType === "string" &&
    typeof obj.orderIndex === "number" &&
    typeof obj.createdAt === "number" &&
    typeof obj.retryCount === "number"
  );
}

function isContentReplacement(value: unknown): value is ContentReplacement {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.sessionId === "string" &&
    typeof obj.messageId === "string" &&
    typeof obj.filePath === "string" &&
    typeof obj.byteCount === "number" &&
    typeof obj.replacedAt === "number"
  );
}

export function createNexusSessionPersistence(
  transport: NexusTransport,
  basePath: string,
  lockScope: string,
): SessionPersistence {
  async function loadRecord(sessionId: string): Promise<Result<SessionRecord, KoiError>> {
    const loaded = await readJson<unknown>(transport, sessionRecordPath(basePath, sessionId));
    if (!loaded.ok) return loaded;
    if (loaded.value === undefined) {
      return { ok: false, error: notFound(sessionId, `Session not found: ${sessionId}`) };
    }
    if (!isSessionRecord(loaded.value)) {
      return {
        ok: false,
        error: {
          code: "INTERNAL",
          message: `Invalid session record at ${sessionId}`,
          retryable: false,
        },
      };
    }
    return { ok: true, value: loaded.value };
  }

  async function listPendingPaths(sessionId: string): Promise<Result<readonly string[], KoiError>> {
    return listFilePaths(transport, `${basePath}/pending/${encodeURIComponent(sessionId)}`);
  }

  async function listReplacementPaths(
    sessionId: string,
  ): Promise<Result<readonly string[], KoiError>> {
    return listFilePaths(
      transport,
      `${basePath}/content-replacements/${encodeURIComponent(sessionId)}`,
    );
  }

  const saveSession: SessionPersistence["saveSession"] = async (
    record: SessionRecord,
  ): Promise<Result<void, KoiError>> => {
    const sessionCheck = validateNonEmpty(record.sessionId, "Session ID");
    if (!sessionCheck.ok) return sessionCheck;
    const agentCheck = validateNonEmpty(record.agentId, "Agent ID");
    if (!agentCheck.ok) return agentCheck;
    return writeJson(transport, sessionRecordPath(basePath, record.sessionId), record);
  };

  const loadSession: SessionPersistence["loadSession"] = async (
    sessionId: string,
  ): Promise<Result<SessionRecord, KoiError>> => {
    const check = validateNonEmpty(sessionId, "Session ID");
    if (!check.ok) return check;
    return loadRecord(sessionId);
  };

  const removeSession: SessionPersistence["removeSession"] = async (
    sessionId: string,
  ): Promise<Result<void, KoiError>> => {
    const check = validateNonEmpty(sessionId, "Session ID");
    if (!check.ok) return check;
    const loaded = await loadRecord(sessionId);
    if (!loaded.ok) return loaded;
    const recordDeleted = await deletePath(transport, sessionRecordPath(basePath, sessionId));
    if (!recordDeleted.ok) return recordDeleted;

    const pending = await listPendingPaths(sessionId);
    if (!pending.ok) return pending;
    for (const path of pending.value) {
      const deleted = await deletePath(transport, path);
      if (!deleted.ok) return deleted;
    }

    const replacements = await listReplacementPaths(sessionId);
    if (!replacements.ok) return replacements;
    for (const path of replacements.value) {
      const deleted = await deletePath(transport, path);
      if (!deleted.ok) return deleted;
    }

    return { ok: true, value: undefined };
  };

  const listSessions: SessionPersistence["listSessions"] = async (
    filter?: SessionFilter,
  ): Promise<Result<readonly SessionRecord[], KoiError>> => {
    const paths = await listFilePaths(transport, `${basePath}/records`);
    if (!paths.ok) return paths;
    const records: SessionRecord[] = [];
    for (const path of paths.value) {
      const loaded = await readJson<unknown>(transport, path);
      if (!loaded.ok) return loaded;
      if (isSessionRecord(loaded.value)) {
        if (filter?.agentId !== undefined && loaded.value.agentId !== filter.agentId) continue;
        records.push(loaded.value);
      }
    }
    return { ok: true, value: records };
  };

  const savePendingFrame: SessionPersistence["savePendingFrame"] = async (
    frame: PendingFrame,
  ): Promise<Result<void, KoiError>> => {
    const frameCheck = validateNonEmpty(frame.frameId, "Frame ID");
    if (!frameCheck.ok) return frameCheck;
    const sessionCheck = validateNonEmpty(frame.sessionId, "Session ID");
    if (!sessionCheck.ok) return sessionCheck;
    return writeJson(transport, pendingFramePath(basePath, frame.sessionId, frame.frameId), frame);
  };

  const loadPendingFrames: SessionPersistence["loadPendingFrames"] = async (
    sessionId: string,
  ): Promise<Result<readonly PendingFrame[], KoiError>> => {
    const check = validateNonEmpty(sessionId, "Session ID");
    if (!check.ok) return check;
    const paths = await listPendingPaths(sessionId);
    if (!paths.ok) return paths;
    const frames: PendingFrame[] = [];
    for (const path of paths.value) {
      const loaded = await readJson<unknown>(transport, path);
      if (!loaded.ok) return loaded;
      if (isPendingFrame(loaded.value)) frames.push(loaded.value);
    }
    return { ok: true, value: frames.sort((a, b) => a.orderIndex - b.orderIndex) };
  };

  const clearPendingFrames: SessionPersistence["clearPendingFrames"] = async (
    sessionId: string,
  ): Promise<Result<void, KoiError>> => {
    const check = validateNonEmpty(sessionId, "Session ID");
    if (!check.ok) return check;
    const paths = await listPendingPaths(sessionId);
    if (!paths.ok) return paths;
    for (const path of paths.value) {
      const deleted = await deletePath(transport, path);
      if (!deleted.ok) return deleted;
    }
    return { ok: true, value: undefined };
  };

  const removePendingFrame: SessionPersistence["removePendingFrame"] = async (
    frameId: string,
  ): Promise<Result<void, KoiError>> => {
    const check = validateNonEmpty(frameId, "Frame ID");
    if (!check.ok) return check;
    const paths = await listFilePaths(transport, `${basePath}/pending`);
    if (!paths.ok) return paths;
    const suffix = `/${encodeURIComponent(frameId)}.json`;
    for (const path of paths.value.filter((candidate) => candidate.endsWith(suffix))) {
      const deleted = await deletePath(transport, path);
      if (!deleted.ok) return deleted;
    }
    return { ok: true, value: undefined };
  };

  const updateLastEngineState: NonNullable<SessionPersistence["updateLastEngineState"]> = async (
    sessionId: string,
    apply: (prev: EngineState | undefined) => EngineState | undefined,
    nowMs: number,
    expectedVersion?: number,
  ): Promise<Result<void, KoiError>> => {
    const check = validateNonEmpty(sessionId, "Session ID");
    if (!check.ok) return check;
    return withLock(`${lockScope}:session:${sessionId}`, async () => {
      const loaded = await loadRecord(sessionId);
      if (!loaded.ok) return loaded;
      if (expectedVersion !== undefined && loaded.value.lastPersistedAt !== expectedVersion) {
        return {
          ok: false,
          error: conflict(
            `Session ${sessionId} version mismatch — expected ${expectedVersion}, found ${loaded.value.lastPersistedAt}`,
          ),
        };
      }
      return writeJson(transport, sessionRecordPath(basePath, sessionId), {
        ...loaded.value,
        lastEngineState: apply(loaded.value.lastEngineState),
        lastPersistedAt: nowMs,
      });
    });
  };

  const setSessionStatus: SessionPersistence["setSessionStatus"] = async (
    sessionId: string,
    status: SessionStatus,
  ): Promise<Result<void, KoiError>> => {
    const check = validateNonEmpty(sessionId, "Session ID");
    if (!check.ok) return check;
    return withLock(`${lockScope}:session:${sessionId}`, async () => {
      const loaded = await loadRecord(sessionId);
      if (!loaded.ok) return loaded;
      return writeJson(transport, sessionRecordPath(basePath, sessionId), {
        ...loaded.value,
        status,
      });
    });
  };

  const saveContentReplacement: SessionPersistence["saveContentReplacement"] = async (
    record: ContentReplacement,
  ): Promise<Result<void, KoiError>> => {
    const sessionCheck = validateNonEmpty(record.sessionId, "Session ID");
    if (!sessionCheck.ok) return sessionCheck;
    const messageCheck = validateNonEmpty(record.messageId, "Message ID");
    if (!messageCheck.ok) return messageCheck;
    return writeJson(
      transport,
      contentReplacementPath(basePath, record.sessionId, record.messageId),
      record,
    );
  };

  const loadContentReplacements: SessionPersistence["loadContentReplacements"] = async (
    sessionId: string,
  ): Promise<Result<readonly ContentReplacement[], KoiError>> => {
    const check = validateNonEmpty(sessionId, "Session ID");
    if (!check.ok) return check;
    const paths = await listReplacementPaths(sessionId);
    if (!paths.ok) return paths;
    const replacements: ContentReplacement[] = [];
    for (const path of paths.value) {
      const loaded = await readJson<unknown>(transport, path);
      if (!loaded.ok) return loaded;
      if (isContentReplacement(loaded.value)) replacements.push(loaded.value);
    }
    return { ok: true, value: replacements };
  };

  const recover: SessionPersistence["recover"] = async (): Promise<
    Result<RecoveryPlan, KoiError>
  > => {
    const sessions = await listSessions();
    if (!sessions.ok) return sessions;
    const pendingPaths = await listFilePaths(transport, `${basePath}/pending`);
    if (!pendingPaths.ok) return pendingPaths;
    const pendingFrames = new Map<string, PendingFrame[]>();
    for (const path of pendingPaths.value) {
      const loaded = await readJson<unknown>(transport, path);
      if (!loaded.ok) return loaded;
      if (!isPendingFrame(loaded.value)) continue;
      const existing = pendingFrames.get(loaded.value.sessionId) ?? [];
      pendingFrames.set(loaded.value.sessionId, [...existing, loaded.value]);
    }
    for (const [sessionId, frames] of pendingFrames) {
      pendingFrames.set(
        sessionId,
        frames.sort((a, b) => a.orderIndex - b.orderIndex),
      );
    }
    return {
      ok: true,
      value: {
        sessions: sessions.value,
        pendingFrames,
        skipped: [],
      },
    };
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
    updateLastEngineState,
    setSessionStatus,
    saveContentReplacement,
    loadContentReplacements,
    recover,
    close: () => undefined,
  };
}
