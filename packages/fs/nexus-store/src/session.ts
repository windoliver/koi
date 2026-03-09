/**
 * Nexus-backed SessionPersistence implementation.
 *
 * Stores session records and pending frames as JSON files
 * on a Nexus server.
 *
 * Path convention:
 *   /session/records/{sessionId}.json
 *   /session/pending/{sessionId}/{frameId}.json
 */

import type {
  KoiError,
  PendingFrame,
  RecoveryPlan,
  Result,
  SessionFilter,
  SessionPersistence,
  SessionRecord,
  SkippedRecoveryEntry,
} from "@koi/core";
import { notFound, validateNonEmpty } from "@koi/core";
import type { NexusClient } from "@koi/nexus-client";
import { createNexusClient } from "@koi/nexus-client";
import { validatePathSegment, wrapNexusError } from "./shared/nexus-helpers.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_BASE_PATH = "session";

export interface NexusSessionStoreConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly basePath?: string;
  readonly fetch?: typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a Nexus-backed SessionPersistence for multi-node deployments. */
export function createNexusSessionStore(config: NexusSessionStoreConfig): SessionPersistence {
  const basePath = config.basePath ?? DEFAULT_BASE_PATH;
  const client: NexusClient = createNexusClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    fetch: config.fetch,
  });

  // --- path helpers -------------------------------------------------------

  function sessionPath(sid: string): string {
    return `${basePath}/records/${sid}.json`;
  }

  function framePath(sid: string, frameId: string): string {
    return `${basePath}/pending/${sid}/${frameId}.json`;
  }

  // --- generic read/write helpers -----------------------------------------

  async function readJson<T>(path: string): Promise<Result<T, KoiError>> {
    const r = await client.rpc<string>("read", { path });
    if (!r.ok) return r;
    try {
      return { ok: true, value: JSON.parse(r.value) as T };
    } catch (e: unknown) {
      return { ok: false, error: wrapNexusError("INTERNAL", `Failed to parse JSON at ${path}`, e) };
    }
  }

  async function writeJson(path: string, data: unknown): Promise<Result<void, KoiError>> {
    const r = await client.rpc<null>("write", { path, content: JSON.stringify(data) });
    if (!r.ok) return r;
    return { ok: true, value: undefined };
  }

  // --- SessionPersistence methods -----------------------------------------

  const saveSession = async (record: SessionRecord): Promise<Result<void, KoiError>> => {
    const idCheck = validateNonEmpty(record.sessionId, "Session ID");
    if (!idCheck.ok) return idCheck;
    const segCheck = validatePathSegment(record.sessionId, "Session ID");
    if (!segCheck.ok) return segCheck;
    const agentCheck = validateNonEmpty(record.agentId, "Agent ID");
    if (!agentCheck.ok) return agentCheck;
    const agentSegCheck = validatePathSegment(record.agentId, "Agent ID");
    if (!agentSegCheck.ok) return agentSegCheck;

    return writeJson(sessionPath(record.sessionId), record);
  };

  const loadSession = async (sid: string): Promise<Result<SessionRecord, KoiError>> => {
    const idCheck = validateNonEmpty(sid, "Session ID");
    if (!idCheck.ok) return idCheck;
    const segCheck = validatePathSegment(sid, "Session ID");
    if (!segCheck.ok) return segCheck;

    const r = await readJson<SessionRecord>(sessionPath(sid));
    if (!r.ok) {
      if (r.error.code === "EXTERNAL" || r.error.code === "NOT_FOUND") {
        return { ok: false, error: notFound(sid, `Session not found: ${sid}`) };
      }
      return r;
    }
    return r;
  };

  const removeSession = async (sid: string): Promise<Result<void, KoiError>> => {
    const idCheck = validateNonEmpty(sid, "Session ID");
    if (!idCheck.ok) return idCheck;
    const segCheck = validatePathSegment(sid, "Session ID");
    if (!segCheck.ok) return segCheck;

    // Verify session exists
    const sessionResult = await readJson<SessionRecord>(sessionPath(sid));
    if (!sessionResult.ok) {
      return { ok: false, error: notFound(sid, `Session not found: ${sid}`) };
    }

    // Delete pending frames for this session only
    const frameGlob = await client.rpc<readonly string[]>("glob", {
      pattern: `${basePath}/pending/${sid}/*.json`,
    });
    if (frameGlob.ok) {
      for (const fp of frameGlob.value) {
        await client.rpc<null>("delete", { path: fp });
      }
    }

    // Delete session record
    await client.rpc<null>("delete", { path: sessionPath(sid) });
    return { ok: true, value: undefined };
  };

  const listSessions = async (
    filter?: SessionFilter,
  ): Promise<Result<readonly SessionRecord[], KoiError>> => {
    const globResult = await client.rpc<readonly string[]>("glob", {
      pattern: `${basePath}/records/*.json`,
    });
    if (!globResult.ok) return globResult;

    const records: SessionRecord[] = [];
    for (const p of globResult.value) {
      const r = await readJson<SessionRecord>(p);
      if (!r.ok) continue;
      if (filter?.agentId !== undefined && r.value.agentId !== filter.agentId) continue;
      records.push(r.value);
    }

    return { ok: true, value: records };
  };

  const savePendingFrame = async (frame: PendingFrame): Promise<Result<void, KoiError>> => {
    const idCheck = validateNonEmpty(frame.frameId, "Frame ID");
    if (!idCheck.ok) return idCheck;
    const frameSegCheck = validatePathSegment(frame.frameId, "Frame ID");
    if (!frameSegCheck.ok) return frameSegCheck;
    const sessionCheck = validateNonEmpty(frame.sessionId, "Session ID");
    if (!sessionCheck.ok) return sessionCheck;
    const sessionSegCheck = validatePathSegment(frame.sessionId, "Session ID");
    if (!sessionSegCheck.ok) return sessionSegCheck;

    return writeJson(framePath(frame.sessionId, frame.frameId), frame);
  };

  const loadPendingFrames = async (
    sid: string,
  ): Promise<Result<readonly PendingFrame[], KoiError>> => {
    const idCheck = validateNonEmpty(sid, "Session ID");
    if (!idCheck.ok) return idCheck;
    const segCheck = validatePathSegment(sid, "Session ID");
    if (!segCheck.ok) return segCheck;

    const globResult = await client.rpc<readonly string[]>("glob", {
      pattern: `${basePath}/pending/${sid}/*.json`,
    });
    if (!globResult.ok) return globResult;

    const frames: PendingFrame[] = [];
    for (const p of globResult.value) {
      const r = await readJson<PendingFrame>(p);
      if (r.ok) frames.push(r.value);
    }

    // Sort by orderIndex
    frames.sort((a, b) => a.orderIndex - b.orderIndex);
    return { ok: true, value: frames };
  };

  const clearPendingFrames = async (sid: string): Promise<Result<void, KoiError>> => {
    const idCheck = validateNonEmpty(sid, "Session ID");
    if (!idCheck.ok) return idCheck;
    const segCheck = validatePathSegment(sid, "Session ID");
    if (!segCheck.ok) return segCheck;

    const globResult = await client.rpc<readonly string[]>("glob", {
      pattern: `${basePath}/pending/${sid}/*.json`,
    });
    if (!globResult.ok) return globResult;

    for (const p of globResult.value) {
      await client.rpc<null>("delete", { path: p });
    }
    return { ok: true, value: undefined };
  };

  const removePendingFrame = async (frameId: string): Promise<Result<void, KoiError>> => {
    const idCheck = validateNonEmpty(frameId, "Frame ID");
    if (!idCheck.ok) return idCheck;
    const segCheck = validatePathSegment(frameId, "Frame ID");
    if (!segCheck.ok) return segCheck;

    // Find frame by globbing (frameId is unique across sessions)
    const globResult = await client.rpc<readonly string[]>("glob", {
      pattern: `${basePath}/pending/*/${frameId}.json`,
    });
    if (!globResult.ok) return globResult;

    for (const p of globResult.value) {
      await client.rpc<null>("delete", { path: p });
    }
    return { ok: true, value: undefined };
  };

  const recover = async (): Promise<Result<RecoveryPlan, KoiError>> => {
    const skipped: SkippedRecoveryEntry[] = [];

    // Sessions
    const sessionGlob = await client.rpc<readonly string[]>("glob", {
      pattern: `${basePath}/records/*.json`,
    });
    const sessions: SessionRecord[] = [];
    if (sessionGlob.ok) {
      for (const p of sessionGlob.value) {
        const r = await readJson<SessionRecord>(p);
        if (r.ok) {
          sessions.push(r.value);
        } else {
          const fileName = p.split("/").pop() ?? p;
          skipped.push({
            source: "session",
            id: fileName.replace(".json", ""),
            error: r.error.message,
          });
        }
      }
    }

    // Pending frames per session
    const pendingFrames = new Map<string, PendingFrame[]>();
    for (const session of sessions) {
      const sid = session.sessionId;
      const frameGlob = await client.rpc<readonly string[]>("glob", {
        pattern: `${basePath}/pending/${sid}/*.json`,
      });
      if (!frameGlob.ok) continue;

      for (const p of frameGlob.value) {
        const r = await readJson<PendingFrame>(p);
        if (r.ok) {
          const existing = pendingFrames.get(sid);
          if (existing !== undefined) {
            existing.push(r.value);
          } else {
            pendingFrames.set(sid, [r.value]);
          }
        } else {
          const frameId = p.split("/").pop()?.replace(".json", "") ?? p;
          skipped.push({ source: "pending_frame", id: frameId, error: r.error.message });
        }
      }
    }

    return { ok: true, value: { sessions, pendingFrames, skipped } };
  };

  const close = (): void => {
    // No persistent resources to release for Nexus RPC
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
