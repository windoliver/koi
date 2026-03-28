/**
 * In-memory SessionPersistence — CLI-only, no persistence across restarts.
 *
 * Extracted from resolve-autonomous.ts for file-size hygiene.
 */

import type {
  PendingFrame,
  RecoveryPlan,
  SessionFilter,
  SessionPersistence,
  SessionRecord,
} from "@koi/core";

export function createInMemorySessionPersistence(): SessionPersistence {
  const sessions = new Map<string, SessionRecord>();
  const frames = new Map<string, PendingFrame[]>();

  const ok = <T>(value: T): { readonly ok: true; readonly value: T } => ({
    ok: true,
    value,
  });

  const notFound = (
    id: string,
  ): {
    readonly ok: false;
    readonly error: {
      readonly code: "NOT_FOUND";
      readonly message: string;
      readonly retryable: false;
    };
  } => ({
    ok: false,
    error: { code: "NOT_FOUND", message: `Session ${id} not found`, retryable: false },
  });

  return {
    saveSession: (record) => {
      sessions.set(record.sessionId, record);
      return ok(undefined);
    },

    loadSession: (sid) => {
      const record = sessions.get(sid);
      if (record === undefined) return notFound(sid);
      return ok(record);
    },

    removeSession: (sid) => {
      sessions.delete(sid);
      frames.delete(sid);
      return ok(undefined);
    },

    listSessions: (filter?: SessionFilter) => {
      const all = [...sessions.values()];
      if (filter === undefined) return ok(all);
      const filtered = all.filter((s) => {
        if (filter.agentId !== undefined && s.agentId !== filter.agentId) return false;
        return true;
      });
      return ok(filtered);
    },

    savePendingFrame: (frame) => {
      const existing = frames.get(frame.sessionId) ?? [];
      frames.set(frame.sessionId, [...existing, frame]);
      return ok(undefined);
    },

    loadPendingFrames: (sid) => {
      const arr = frames.get(sid) ?? [];
      const sorted = [...arr].sort((a, b) => a.orderIndex - b.orderIndex);
      return ok(sorted);
    },

    clearPendingFrames: (sid) => {
      frames.delete(sid);
      return ok(undefined);
    },

    removePendingFrame: (frameId) => {
      for (const [, arr] of frames) {
        const idx = arr.findIndex((f) => f.frameId === frameId);
        if (idx !== -1) {
          arr.splice(idx, 1);
          break;
        }
      }
      return ok(undefined);
    },

    recover: (): {
      readonly ok: true;
      readonly value: RecoveryPlan;
    } => {
      const allSessions = [...sessions.values()];
      const pendingFrames = new Map<string, readonly PendingFrame[]>();
      for (const [sid, arr] of frames) {
        pendingFrames.set(sid, arr);
      }
      return ok({ sessions: allSessions, pendingFrames, skipped: [] });
    },

    close: () => {
      sessions.clear();
      frames.clear();
    },
  };
}
