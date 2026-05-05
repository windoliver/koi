import type { TrajectoryEntry, TrajectoryStore } from "@koi/ace-types";

import {
  basenameNoExt,
  decodeAceId,
  encodeAceId,
  listChildren,
  readJson,
  validateAceId,
  writeJson,
} from "./json-io.js";
import type { NexusPlaybookStoreConfig } from "./types.js";

const DEFAULT_BASE = "ace";

/**
 * Per-batch trajectory file layout.
 *
 * Each `append` call writes ONE immutable batch file:
 *   <basePath>/trajectories/<encodedSessionId>/<batchId>.json
 *
 * where `batchId` is `${timestamp}-${seq4}-${randomSlice}`.
 * The per-session lock serializes in-process appends; the seq counter ensures
 * strictly-increasing batchIds even when Date.now() ties within a millisecond.
 *
 * Cross-instance correctness: disjoint filenames — two processes appending
 * concurrently produce separate batch files; `getSession` flattens all of them.
 */
export function createNexusTrajectoryStore(config: NexusPlaybookStoreConfig): TrajectoryStore {
  const base = config.basePath ?? DEFAULT_BASE;
  const dir = `${base}/trajectories`;
  const transport = config.transport;
  const sessionLocks = new Map<string, Promise<void>>();
  // Per-session monotonic sequence number to break timestamp ties
  const sessionSeq = new Map<string, number>();

  function sessionDir(sessionId: string): string {
    return `${dir}/${encodeAceId(sessionId)}`;
  }

  function batchPath(sessionId: string, batchId: string): string {
    return `${sessionDir(sessionId)}/${batchId}.json`;
  }

  async function withSessionLock<R>(sessionId: string, fn: () => Promise<R>): Promise<R> {
    const prev = sessionLocks.get(sessionId) ?? Promise.resolve();
    // let is justified: release must be assigned inside the Promise constructor callback
    let release = (): void => {};
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    sessionLocks.set(sessionId, next);
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  return {
    async append(sessionId: string, entries: readonly TrajectoryEntry[]): Promise<void> {
      const v = validateAceId(sessionId, "Session ID");
      if (!v.ok) throw new Error(v.error.message);
      await withSessionLock(sessionId, async () => {
        // Strictly increasing batchId: timestamp + zero-padded seq + random suffix.
        // Seq breaks ties when Date.now() returns the same value for two serial appends
        // within ONE process. CROSS-PROCESS ORDERING LIMIT: two separate processes
        // appending concurrently produce disjoint files; getSession sorts by batchId
        // filename. Clock skew or same-millisecond appends from different instances
        // cause the UUID suffix to determine order — i.e., cross-process append order
        // is UNDEFINED. Distributed deployments requiring strict ordering must funnel
        // writes through a single coordinator or add a `seq` field to TrajectoryEntry.
        // See docs/L2/playbook-store-nexus.md "Concurrency limits" and issue #1469.
        const seq = (sessionSeq.get(sessionId) ?? 0) + 1;
        sessionSeq.set(sessionId, seq);
        const batchId = `${Date.now()}-${String(seq).padStart(6, "0")}-${crypto.randomUUID().slice(0, 8)}`;
        const r = await writeJson(transport, batchPath(sessionId, batchId), entries);
        if (!r.ok) throw new Error(r.error.message);
      });
    },

    async getSession(sessionId: string): Promise<readonly TrajectoryEntry[]> {
      const v = validateAceId(sessionId, "Session ID");
      if (!v.ok) throw new Error(v.error.message);
      const lr = await listChildren(transport, `${sessionDir(sessionId)}/*.json`);
      if (!lr.ok) throw new Error(lr.error.message);
      if (lr.value.length === 0) return [];
      // Sort by batchId filename (timestamp+seq prefix gives chronological order)
      const sorted = [...lr.value].sort((a, b) => {
        const aName = basenameNoExt(a);
        const bName = basenameNoExt(b);
        return aName < bName ? -1 : aName > bName ? 1 : 0;
      });
      const out: TrajectoryEntry[] = [];
      for (const p of sorted) {
        const r = await readJson<TrajectoryEntry[]>(transport, p);
        if (!r.ok) throw new Error(r.error.message);
        if (r.value !== undefined) out.push(...r.value);
      }
      return out;
    },

    async listSessions(_options?: {
      readonly limit?: number;
      readonly before?: number;
    }): Promise<readonly string[]> {
      // List all batch files under <basePath>/trajectories/*/*.json
      // Extract the session directory segment (second-to-last path component).
      const lr = await listChildren(transport, `${dir}/*/*.json`);
      if (!lr.ok) throw new Error(lr.error.message);
      const sessionSet = new Set<string>();
      for (const p of lr.value) {
        const parts = p.split("/");
        // path: <dir>/<encodedSessionId>/<batchId>.json
        const encodedSessionId = parts[parts.length - 2];
        if (encodedSessionId !== undefined) {
          sessionSet.add(decodeAceId(encodedSessionId));
        }
      }
      const sessions = [...sessionSet];
      if (_options?.limit !== undefined) return sessions.slice(0, _options.limit);
      return sessions;
    },
  };
}
