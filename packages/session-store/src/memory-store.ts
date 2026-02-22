/**
 * InMemorySessionPersistence — Map-based store for tests and development.
 * No persistence across restarts. Implements checkpoint retention.
 */

import type { AgentId, KoiError, Result } from "@koi/core";
import { notFound, validation } from "@koi/core";
import type { SessionPersistence } from "./persistence.js";
import type {
  PendingFrame,
  RecoveryPlan,
  SessionCheckpoint,
  SessionFilter,
  SessionRecord,
} from "./types.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CHECKPOINTS_PER_AGENT = 3;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateNonEmpty(value: string, name: string): Result<void, KoiError> {
  if (value === "") {
    return { ok: false, error: validation(`${name} must not be empty`) };
  }
  return { ok: true, value: undefined };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface InMemorySessionStoreConfig {
  readonly maxCheckpointsPerAgent?: number;
}

export function createInMemorySessionPersistence(
  config?: InMemorySessionStoreConfig,
): SessionPersistence {
  const maxCheckpoints = config?.maxCheckpointsPerAgent ?? DEFAULT_MAX_CHECKPOINTS_PER_AGENT;
  const sessions = new Map<string, SessionRecord>();
  // agentId → checkpoints (newest first)
  const checkpointsByAgent = new Map<string, SessionCheckpoint[]>();
  // sessionId → pending frames (ordered by orderIndex)
  const pendingFramesBySession = new Map<string, PendingFrame[]>();

  function agentCheckpoints(agentId: string): SessionCheckpoint[] {
    let list = checkpointsByAgent.get(agentId);
    if (list === undefined) {
      list = [];
      checkpointsByAgent.set(agentId, list);
    }
    return list;
  }

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
    // Also remove checkpoints for this session's agent
    checkpointsByAgent.delete(record.agentId);
    // Also remove pending frames for this session
    pendingFramesBySession.delete(sessionId);
    return { ok: true, value: undefined };
  };

  const listSessions = (filter?: SessionFilter): Result<readonly SessionRecord[], KoiError> => {
    const results: SessionRecord[] = [];
    for (const record of sessions.values()) {
      if (filter?.agentId !== undefined && record.agentId !== filter.agentId) continue;
      // Filter by processState: check the latest checkpoint for this agent
      if (filter?.processState !== undefined) {
        const checkpoints = checkpointsByAgent.get(record.agentId);
        const latest = checkpoints?.[0];
        if (latest === undefined || latest.processState !== filter.processState) continue;
      }
      results.push(record);
    }
    return { ok: true, value: results };
  };

  const saveCheckpoint = (checkpoint: SessionCheckpoint): Result<void, KoiError> => {
    const idCheck = validateNonEmpty(checkpoint.id, "Checkpoint ID");
    if (!idCheck.ok) return idCheck;
    const agentCheck = validateNonEmpty(checkpoint.agentId, "Agent ID");
    if (!agentCheck.ok) return agentCheck;

    const list = agentCheckpoints(checkpoint.agentId);
    // Insert at front (newest first), maintain sorted order by createdAt desc
    list.unshift(checkpoint);
    list.sort((a, b) => b.createdAt - a.createdAt);

    // Prune oldest beyond retention limit
    while (list.length > maxCheckpoints) {
      list.pop();
    }

    return { ok: true, value: undefined };
  };

  const loadLatestCheckpoint = (
    agentId: AgentId,
  ): Result<SessionCheckpoint | undefined, KoiError> => {
    const agentCheck = validateNonEmpty(agentId, "Agent ID");
    if (!agentCheck.ok) return agentCheck;

    const list = checkpointsByAgent.get(agentId);
    return { ok: true, value: list?.[0] };
  };

  const listCheckpoints = (agentId: AgentId): Result<readonly SessionCheckpoint[], KoiError> => {
    const agentCheck = validateNonEmpty(agentId, "Agent ID");
    if (!agentCheck.ok) return agentCheck;

    const list = checkpointsByAgent.get(agentId) ?? [];
    return { ok: true, value: [...list] };
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
    const checkpointMap = new Map<string, SessionCheckpoint>();
    for (const [agentId, list] of checkpointsByAgent) {
      if (list.length > 0 && list[0] !== undefined) {
        checkpointMap.set(agentId, list[0]);
      }
    }
    const pendingFrames = new Map<string, PendingFrame[]>();
    for (const [sessionId, frames] of pendingFramesBySession) {
      if (frames.length > 0) {
        pendingFrames.set(sessionId, [...frames]);
      }
    }
    return {
      ok: true,
      value: { sessions: allSessions, checkpoints: checkpointMap, pendingFrames },
    };
  };

  const close = (): void => {
    sessions.clear();
    checkpointsByAgent.clear();
    pendingFramesBySession.clear();
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
