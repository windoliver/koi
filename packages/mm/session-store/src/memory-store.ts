/**
 * InMemorySessionPersistence — Map-based store for tests and development.
 * No persistence across restarts.
 */

import type {
  KoiError,
  PendingFrame,
  RecoveryPlan,
  Result,
  SessionFilter,
  SessionPersistence,
  SessionRecord,
} from "@koi/core";
import { notFound, validateNonEmpty } from "@koi/core";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createInMemorySessionPersistence(): SessionPersistence {
  const sessions = new Map<string, SessionRecord>();
  // sessionId → pending frames (ordered by orderIndex)
  const pendingFramesBySession = new Map<string, PendingFrame[]>();

  const saveSession = (record: SessionRecord): Result<void, KoiError> => {
    const idCheck = validateNonEmpty(record.sessionId, "Session ID");
    if (!idCheck.ok) return idCheck;
    const agentCheck = validateNonEmpty(record.agentId, "Agent ID");
    if (!agentCheck.ok) return agentCheck;

    sessions.set(record.sessionId, record);
    return { ok: true, value: undefined };
  };

  const loadSession = (sessionId: string): Result<SessionRecord, KoiError> => {
    const idCheck = validateNonEmpty(sessionId, "Session ID");
    if (!idCheck.ok) return idCheck;

    const record = sessions.get(sessionId);
    if (record === undefined) {
      return { ok: false, error: notFound(sessionId, `Session not found: ${sessionId}`) };
    }
    return { ok: true, value: record };
  };

  const removeSession = (sessionId: string): Result<void, KoiError> => {
    const idCheck = validateNonEmpty(sessionId, "Session ID");
    if (!idCheck.ok) return idCheck;

    const record = sessions.get(sessionId);
    if (record === undefined) {
      return { ok: false, error: notFound(sessionId, `Session not found: ${sessionId}`) };
    }
    sessions.delete(sessionId);
    // Cascade pending frames by agentId (across all sessions for this agent)
    for (const [sid, frames] of pendingFramesBySession) {
      if (frames[0]?.agentId === record.agentId) {
        pendingFramesBySession.delete(sid);
      }
    }
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
    // Upsert: replace existing frame with same frameId
    const existingIndex = existing.findIndex((f) => f.frameId === frame.frameId);
    const updated =
      existingIndex >= 0
        ? [...existing.slice(0, existingIndex), frame, ...existing.slice(existingIndex + 1)]
        : [...existing, frame];
    pendingFramesBySession.set(
      frame.sessionId,
      [...updated].sort((a, b) => a.orderIndex - b.orderIndex),
    );
    return { ok: true, value: undefined };
  };

  const loadPendingFrames = (sessionId: string): Result<readonly PendingFrame[], KoiError> => {
    const idCheck = validateNonEmpty(sessionId, "Session ID");
    if (!idCheck.ok) return idCheck;

    const list = pendingFramesBySession.get(sessionId) ?? [];
    return { ok: true, value: [...list] };
  };

  const clearPendingFrames = (sessionId: string): Result<void, KoiError> => {
    const idCheck = validateNonEmpty(sessionId, "Session ID");
    if (!idCheck.ok) return idCheck;

    pendingFramesBySession.delete(sessionId);
    return { ok: true, value: undefined };
  };

  const removePendingFrame = (frameId: string): Result<void, KoiError> => {
    const idCheck = validateNonEmpty(frameId, "Frame ID");
    if (!idCheck.ok) return idCheck;

    for (const [sessionId, frames] of pendingFramesBySession) {
      const idx = frames.findIndex((f) => f.frameId === frameId);
      if (idx >= 0) {
        const remaining = [...frames.slice(0, idx), ...frames.slice(idx + 1)];
        if (remaining.length === 0) {
          pendingFramesBySession.delete(sessionId);
        } else {
          pendingFramesBySession.set(sessionId, remaining);
        }
        break;
      }
    }
    return { ok: true, value: undefined };
  };

  const recover = (): Result<RecoveryPlan, KoiError> => {
    const allSessions = [...sessions.values()];
    const pendingFrames = new Map<string, PendingFrame[]>();
    for (const [sessionId, frames] of pendingFramesBySession) {
      if (frames.length > 0) {
        pendingFrames.set(sessionId, [...frames]);
      }
    }
    return {
      ok: true,
      value: { sessions: allSessions, pendingFrames, skipped: [] },
    };
  };

  const close = (): void => {
    sessions.clear();
    pendingFramesBySession.clear();
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
