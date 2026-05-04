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

export function createNexusTrajectoryStore(config: NexusPlaybookStoreConfig): TrajectoryStore {
  const base = config.basePath ?? DEFAULT_BASE;
  const dir = `${base}/trajectories`;
  const transport = config.transport;
  const sessionLocks = new Map<string, Promise<void>>();
  const path = (sessionId: string): string => `${dir}/${encodeAceId(sessionId)}.json`;

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
        const existing = await readJson<TrajectoryEntry[]>(transport, path(sessionId));
        if (!existing.ok) throw new Error(existing.error.message);
        const current: TrajectoryEntry[] = existing.value ?? [];
        const r = await writeJson(transport, path(sessionId), [...current, ...entries]);
        if (!r.ok) throw new Error(r.error.message);
      });
    },

    async getSession(sessionId: string): Promise<readonly TrajectoryEntry[]> {
      const v = validateAceId(sessionId, "Session ID");
      if (!v.ok) throw new Error(v.error.message);
      const r = await readJson<TrajectoryEntry[]>(transport, path(sessionId));
      if (!r.ok) throw new Error(r.error.message);
      return r.value ?? [];
    },

    async listSessions(_options?: {
      readonly limit?: number;
      readonly before?: number;
    }): Promise<readonly string[]> {
      const lr = await listChildren(transport, `${dir}/*.json`);
      if (!lr.ok) throw new Error(lr.error.message);
      // Decode the filename stem back to the original session ID
      return lr.value.map((p) => decodeAceId(basenameNoExt(p)));
    },
  };
}
