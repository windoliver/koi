/**
 * InMemorySessionPersistence — Map-based store for tests and development.
 * No persistence across restarts. Implements the SessionPersistence contract.
 */

import type {
  ContentReplacement,
  KoiError,
  PendingFrame,
  RecoveryPlan,
  Result,
  SessionFilter,
  SessionPersistence,
  SessionRecord,
  SessionStatus,
} from "@koi/core";
import { notFound, validateNonEmpty } from "@koi/core";

export function createInMemorySessionPersistence(): SessionPersistence {
  const sessions = new Map<string, SessionRecord>();
  // sessionId → pending frames (maintained sorted by orderIndex)
  const pendingFramesBySession = new Map<string, PendingFrame[]>();
  // sessionId → messageId → ContentReplacement
  const contentReplacements = new Map<string, Map<string, ContentReplacement>>();

  const saveSession = (record: SessionRecord): Result<void, KoiError> => {
    const idCheck = validateNonEmpty(record.sessionId, "Session ID");
    if (!idCheck.ok) return idCheck;
    const agentCheck = validateNonEmpty(record.agentId, "Agent ID");
    if (!agentCheck.ok) return agentCheck;

    sessions.set(record.sessionId, record);
    return { ok: true, value: undefined };
  };

  const loadSession = (sid: string): Result<SessionRecord, KoiError> => {
    const idCheck = validateNonEmpty(sid, "Session ID");
    if (!idCheck.ok) return idCheck;

    const record = sessions.get(sid);
    if (record === undefined) {
      return { ok: false, error: notFound(sid, `Session not found: ${sid}`) };
    }
    return { ok: true, value: record };
  };

  const removeSession = (sid: string): Result<void, KoiError> => {
    const idCheck = validateNonEmpty(sid, "Session ID");
    if (!idCheck.ok) return idCheck;

    if (!sessions.has(sid)) {
      return { ok: false, error: notFound(sid, `Session not found: ${sid}`) };
    }
    sessions.delete(sid);
    pendingFramesBySession.delete(sid);
    contentReplacements.delete(sid);
    return { ok: true, value: undefined };
  };

  const listSessions = (filter?: SessionFilter): Result<readonly SessionRecord[], KoiError> => {
    const results: SessionRecord[] = [];
    for (const record of sessions.values()) {
      if (filter?.agentId !== undefined && record.agentId !== filter.agentId) continue;
      results.push(record);
    }
    return { ok: true, value: results };
  };

  const savePendingFrame = (frame: PendingFrame): Result<void, KoiError> => {
    const idCheck = validateNonEmpty(frame.frameId, "Frame ID");
    if (!idCheck.ok) return idCheck;
    const sessionCheck = validateNonEmpty(frame.sessionId, "Session ID");
    if (!sessionCheck.ok) return sessionCheck;

    const existing = pendingFramesBySession.get(frame.sessionId) ?? [];
    // Upsert: replace existing frame with same frameId, preserving order
    const idx = existing.findIndex((f) => f.frameId === frame.frameId);
    const updated =
      idx >= 0
        ? [...existing.slice(0, idx), frame, ...existing.slice(idx + 1)]
        : [...existing, frame];
    pendingFramesBySession.set(
      frame.sessionId,
      [...updated].sort((a, b) => a.orderIndex - b.orderIndex),
    );
    return { ok: true, value: undefined };
  };

  const loadPendingFrames = (sid: string): Result<readonly PendingFrame[], KoiError> => {
    const idCheck = validateNonEmpty(sid, "Session ID");
    if (!idCheck.ok) return idCheck;

    return { ok: true, value: [...(pendingFramesBySession.get(sid) ?? [])] };
  };

  const clearPendingFrames = (sid: string): Result<void, KoiError> => {
    const idCheck = validateNonEmpty(sid, "Session ID");
    if (!idCheck.ok) return idCheck;

    pendingFramesBySession.delete(sid);
    return { ok: true, value: undefined };
  };

  const removePendingFrame = (frameId: string): Result<void, KoiError> => {
    const idCheck = validateNonEmpty(frameId, "Frame ID");
    if (!idCheck.ok) return idCheck;

    for (const [sid, frames] of pendingFramesBySession) {
      const idx = frames.findIndex((f) => f.frameId === frameId);
      if (idx >= 0) {
        const remaining = [...frames.slice(0, idx), ...frames.slice(idx + 1)];
        if (remaining.length === 0) {
          pendingFramesBySession.delete(sid);
        } else {
          pendingFramesBySession.set(sid, remaining);
        }
        break;
      }
    }
    return { ok: true, value: undefined };
  };

  const setSessionStatus = (sid: string, status: SessionStatus): Result<void, KoiError> => {
    const idCheck = validateNonEmpty(sid, "Session ID");
    if (!idCheck.ok) return idCheck;

    const record = sessions.get(sid);
    if (record === undefined) {
      return { ok: false, error: notFound(sid, `Session not found: ${sid}`) };
    }
    sessions.set(sid, { ...record, status });
    return { ok: true, value: undefined };
  };

  const saveContentReplacement = (record: ContentReplacement): Result<void, KoiError> => {
    const idCheck = validateNonEmpty(record.sessionId, "Session ID");
    if (!idCheck.ok) return idCheck;
    const msgCheck = validateNonEmpty(record.messageId, "Message ID");
    if (!msgCheck.ok) return msgCheck;

    const sessionMap =
      contentReplacements.get(record.sessionId) ?? new Map<string, ContentReplacement>();
    sessionMap.set(record.messageId, record);
    contentReplacements.set(record.sessionId, sessionMap);
    return { ok: true, value: undefined };
  };

  const loadContentReplacements = (
    sid: string,
  ): Result<readonly ContentReplacement[], KoiError> => {
    const idCheck = validateNonEmpty(sid, "Session ID");
    if (!idCheck.ok) return idCheck;

    const sessionMap = contentReplacements.get(sid);
    if (sessionMap === undefined) {
      return { ok: true, value: [] };
    }
    return { ok: true, value: [...sessionMap.values()] };
  };

  const recover = (): Result<RecoveryPlan, KoiError> => {
    const allSessions = [...sessions.values()];
    const pendingFrames = new Map<string, PendingFrame[]>();
    for (const [sid, frames] of pendingFramesBySession) {
      if (frames.length > 0) {
        pendingFrames.set(sid, [...frames]);
      }
    }
    return { ok: true, value: { sessions: allSessions, pendingFrames, skipped: [] } };
  };

  const close = (): void => {
    sessions.clear();
    pendingFramesBySession.clear();
    contentReplacements.clear();
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
