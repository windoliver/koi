/**
 * Store interfaces and in-memory implementations for ACE middleware.
 */

import type { Playbook, StructuredPlaybook, TrajectoryEntry } from "./types.js";

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

/** Creates an in-memory StructuredPlaybookStore for testing and reference. */
export function createInMemoryStructuredPlaybookStore(): StructuredPlaybookStore {
  const playbooks = new Map<string, StructuredPlaybook>();

  return {
    async get(id: string): Promise<StructuredPlaybook | undefined> {
      return playbooks.get(id);
    },

    async list(options?: {
      readonly tags?: readonly string[];
    }): Promise<readonly StructuredPlaybook[]> {
      const all = [...playbooks.values()];
      const tags = options?.tags;
      if (tags !== undefined && tags.length > 0) {
        return all.filter((pb) => tags.some((tag) => pb.tags.includes(tag)));
      }
      return all;
    },

    async save(playbook: StructuredPlaybook): Promise<void> {
      playbooks.set(playbook.id, playbook);
    },

    async remove(id: string): Promise<boolean> {
      return playbooks.delete(id);
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

/** Creates an in-memory PlaybookStore for testing and reference. */
export function createInMemoryPlaybookStore(): PlaybookStore {
  const playbooks = new Map<string, Playbook>();

  return {
    async get(id: string): Promise<Playbook | undefined> {
      return playbooks.get(id);
    },

    async list(options?: {
      readonly tags?: readonly string[];
      readonly minConfidence?: number;
    }): Promise<readonly Playbook[]> {
      const all = [...playbooks.values()];
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

    async save(playbook: Playbook): Promise<void> {
      playbooks.set(playbook.id, playbook);
    },

    async remove(id: string): Promise<boolean> {
      return playbooks.delete(id);
    },
  };
}
