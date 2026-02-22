/**
 * SessionStore: pluggable session persistence.
 * Default in-memory implementation provided.
 */

import type { Session } from "./types.js";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface SessionStore {
  readonly get: (id: string) => Session | undefined;
  readonly set: (session: Session) => void;
  readonly delete: (id: string) => boolean;
  readonly has: (id: string) => boolean;
  readonly size: () => number;
  readonly entries: () => IterableIterator<readonly [string, Session]>;
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

export function createInMemorySessionStore(): SessionStore {
  const map = new Map<string, Session>();

  return {
    get(id: string): Session | undefined {
      return map.get(id);
    },

    set(session: Session): void {
      map.set(session.id, session);
    },

    delete(id: string): boolean {
      return map.delete(id);
    },

    has(id: string): boolean {
      return map.has(id);
    },

    size(): number {
      return map.size;
    },

    entries(): IterableIterator<readonly [string, Session]> {
      return map.entries() as IterableIterator<readonly [string, Session]>;
    },
  };
}
