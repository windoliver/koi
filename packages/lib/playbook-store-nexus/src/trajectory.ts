import type { TrajectoryEntry, TrajectoryStore } from "@koi/ace-types";

import { basenameNoExt, listChildren, readJson, sanitizeId, writeJson } from "./json-io.js";
import type { NexusPlaybookStoreConfig } from "./types.js";

const DEFAULT_BASE = "ace";

export function createNexusTrajectoryStore(config: NexusPlaybookStoreConfig): TrajectoryStore {
  const base = config.basePath ?? DEFAULT_BASE;
  const dir = `${base}/trajectories`;
  const transport = config.transport;
  const path = (sessionId: string): string => `${dir}/${sanitizeId(sessionId)}.json`;

  return {
    async append(sessionId: string, entries: readonly TrajectoryEntry[]): Promise<void> {
      const existing = await readJson<TrajectoryEntry[]>(transport, path(sessionId));
      if (!existing.ok) throw new Error(existing.error.message);
      const current: TrajectoryEntry[] = existing.value ?? [];
      const r = await writeJson(transport, path(sessionId), [...current, ...entries]);
      if (!r.ok) throw new Error(r.error.message);
    },

    async getSession(sessionId: string): Promise<readonly TrajectoryEntry[]> {
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
      return lr.value.map((p) => basenameNoExt(p));
    },
  };
}
