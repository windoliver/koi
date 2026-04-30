/**
 * In-memory PlaybookStore + TrajectoryStore.
 *
 * The default backends. Useful for tests, golden queries, and short-lived
 * processes. Persistent backends (sqlite, Nexus) live in their own L2
 * packages and plug in via `AceConfig.playbookStore`.
 */

import type { Playbook, PlaybookStore, TrajectoryEntry, TrajectoryStore } from "@koi/ace-types";

/** Create an in-memory `PlaybookStore` seeded with optional initial entries. */
export function createInMemoryPlaybookStore(seed?: readonly Playbook[]): PlaybookStore {
  const data = new Map<string, Playbook>();
  if (seed !== undefined) {
    for (const pb of seed) data.set(pb.id, pb);
  }
  const matchesTags = (pb: Playbook, tags?: readonly string[]): boolean => {
    if (tags === undefined || tags.length === 0) return true;
    return tags.every((t) => pb.tags.includes(t));
  };
  return {
    get: async (id) => data.get(id),
    list: async (options) => {
      const minConfidence = options?.minConfidence ?? 0;
      return [...data.values()].filter(
        (pb) => pb.confidence >= minConfidence && matchesTags(pb, options?.tags),
      );
    },
    save: async (pb) => {
      data.set(pb.id, pb);
    },
    remove: async (id) => data.delete(id),
  };
}

/** Create an in-memory `TrajectoryStore`. Sessions live until process exit. */
export function createInMemoryTrajectoryStore(): TrajectoryStore {
  const data = new Map<string, readonly TrajectoryEntry[]>();
  return {
    append: async (sessionId, entries) => {
      const prev = data.get(sessionId) ?? [];
      data.set(sessionId, [...prev, ...entries]);
    },
    getSession: async (sessionId) => data.get(sessionId) ?? [],
    listSessions: async (options) => {
      const all = [...data.keys()];
      const limit = options?.limit;
      return limit !== undefined ? all.slice(0, limit) : all;
    },
  };
}
