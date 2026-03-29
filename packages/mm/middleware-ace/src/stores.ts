/**
 * Store interfaces and implementations for ACE middleware.
 *
 * Provides in-memory (testing) and SQLite (production) backends.
 * Shared CRUD logic is extracted into createMapStore<T> to avoid
 * duplication across store types (Decision 5A).
 */

import type { RichTrajectoryStep, RichTrajectoryStore } from "@koi/core/rich-trajectory";
import type { Playbook, StructuredPlaybook, TrajectoryEntry } from "./types.js";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** TrajectoryStore — append-heavy, per-session trajectory storage. */
export interface TrajectoryStore {
  readonly append: (sessionId: string, entries: readonly TrajectoryEntry[]) => Promise<void>;
  readonly getSession: (sessionId: string) => Promise<readonly TrajectoryEntry[]>;
  readonly listSessions: (options?: {
    readonly limit?: number;
    readonly before?: number;
  }) => Promise<readonly string[]>;
}

/** PlaybookStore — read-heavy, versioned playbook storage. */
export interface PlaybookStore {
  readonly get: (id: string) => Promise<Playbook | undefined>;
  readonly list: (options?: {
    readonly tags?: readonly string[];
    readonly minConfidence?: number;
  }) => Promise<readonly Playbook[]>;
  readonly save: (playbook: Playbook) => Promise<void>;
  readonly remove: (id: string) => Promise<boolean>;
}

/** StructuredPlaybookStore — read-heavy, structured playbook storage. */
export interface StructuredPlaybookStore {
  readonly get: (id: string) => Promise<StructuredPlaybook | undefined>;
  readonly list: (options?: {
    readonly tags?: readonly string[];
  }) => Promise<readonly StructuredPlaybook[]>;
  readonly save: (playbook: StructuredPlaybook) => Promise<void>;
  readonly remove: (id: string) => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Generic map-backed store (Decision 5A — DRY helper)
// ---------------------------------------------------------------------------

interface HasId {
  readonly id: string;
}

interface MapStore<T extends HasId> {
  readonly get: (id: string) => Promise<T | undefined>;
  readonly save: (item: T) => Promise<void>;
  readonly remove: (id: string) => Promise<boolean>;
  readonly values: () => readonly T[];
}

/** Shared get/save/remove backed by a Map. Avoids duplication across store types. */
function createMapStore<T extends HasId>(): MapStore<T> {
  const items = new Map<string, T>();

  return {
    async get(id: string): Promise<T | undefined> {
      return items.get(id);
    },

    async save(item: T): Promise<void> {
      items.set(item.id, item);
    },

    async remove(id: string): Promise<boolean> {
      return items.delete(id);
    },

    values(): readonly T[] {
      return [...items.values()];
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory implementations
// ---------------------------------------------------------------------------

/** Creates an in-memory StructuredPlaybookStore for testing and reference. */
export function createInMemoryStructuredPlaybookStore(): StructuredPlaybookStore {
  const store = createMapStore<StructuredPlaybook>();

  return {
    get: store.get,
    save: store.save,
    remove: store.remove,

    async list(options?: {
      readonly tags?: readonly string[];
    }): Promise<readonly StructuredPlaybook[]> {
      const all = store.values();
      const tags = options?.tags;
      if (tags !== undefined && tags.length > 0) {
        return all.filter((pb) => tags.some((tag) => pb.tags.includes(tag)));
      }
      return all;
    },
  };
}

/** Creates an in-memory TrajectoryStore for testing and reference. */
export function createInMemoryTrajectoryStore(): TrajectoryStore {
  const sessions = new Map<string, readonly TrajectoryEntry[]>();

  return {
    async append(sessionId: string, entries: readonly TrajectoryEntry[]): Promise<void> {
      const existing = sessions.get(sessionId) ?? [];
      sessions.set(sessionId, [...existing, ...entries]);
    },

    async getSession(sessionId: string): Promise<readonly TrajectoryEntry[]> {
      return sessions.get(sessionId) ?? [];
    },

    async listSessions(options?: {
      readonly limit?: number;
      readonly before?: number;
    }): Promise<readonly string[]> {
      const ids = [...sessions.keys()];
      const limit = options?.limit ?? ids.length;
      return ids.slice(0, limit);
    },
  };
}

/** Creates an in-memory RichTrajectoryStore for testing and reference. */
export function createInMemoryRichTrajectoryStore(): RichTrajectoryStore {
  const sessions = new Map<
    string,
    { readonly steps: readonly RichTrajectoryStep[]; readonly timestamp: number }
  >();

  return {
    async append(sessionId: string, steps: readonly RichTrajectoryStep[]): Promise<void> {
      const existing = sessions.get(sessionId);
      const merged = existing !== undefined ? [...existing.steps, ...steps] : [...steps];
      const timestamp = steps.length > 0 ? Math.max(...steps.map((s) => s.timestamp)) : Date.now();
      sessions.set(sessionId, { steps: merged, timestamp });
    },

    async getSession(sessionId: string): Promise<readonly RichTrajectoryStep[]> {
      return sessions.get(sessionId)?.steps ?? [];
    },

    async prune(olderThanMs: number): Promise<number> {
      // let: mutable counter for pruned entries
      let pruned = 0;
      for (const [id, data] of sessions) {
        if (data.timestamp < olderThanMs) {
          sessions.delete(id);
          pruned += data.steps.length;
        }
      }
      return pruned;
    },
  };
}

/** Creates an in-memory PlaybookStore for testing and reference. */
export function createInMemoryPlaybookStore(): PlaybookStore {
  const store = createMapStore<Playbook>();

  return {
    get: store.get,
    save: store.save,
    remove: store.remove,

    async list(options?: {
      readonly tags?: readonly string[];
      readonly minConfidence?: number;
    }): Promise<readonly Playbook[]> {
      const all = store.values();
      return all.filter((pb) => {
        if (options?.minConfidence !== undefined && pb.confidence < options.minConfidence) {
          return false;
        }
        if (options?.tags !== undefined && options.tags.length > 0) {
          return options.tags.some((tag) => pb.tags.includes(tag));
        }
        return true;
      });
    },
  };
}
