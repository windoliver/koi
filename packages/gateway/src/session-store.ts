/**
 * SessionStore: pluggable session persistence.
 * Default in-memory implementation provided.
 *
 * All mutating/querying methods return `Result<T, KoiError>` (or a Promise
 * thereof) so implementations can be sync (in-memory) or async (network)
 * without interface changes.
 */

import type { KoiError, Result } from "@koi/core";
import { notFound } from "@koi/core";
import type { Session } from "./types.js";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface SessionStore {
  readonly get: (id: string) => Result<Session, KoiError> | Promise<Result<Session, KoiError>>;
  readonly set: (session: Session) => Result<void, KoiError> | Promise<Result<void, KoiError>>;
  readonly delete: (id: string) => Result<boolean, KoiError> | Promise<Result<boolean, KoiError>>;
  readonly has: (id: string) => Result<boolean, KoiError> | Promise<Result<boolean, KoiError>>;
  readonly size: () => number;
  readonly entries: () => IterableIterator<readonly [string, Session]>;
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

export function createInMemorySessionStore(): SessionStore {
  const map = new Map<string, Session>();

  return {
    get(id: string): Result<Session, KoiError> {
      const session = map.get(id);
      if (session === undefined) {
        return { ok: false, error: notFound(id, `Session not found: ${id}`) };
      }
      return { ok: true, value: session };
    },

    set(session: Session): Result<void, KoiError> {
      map.set(session.id, session);
      return { ok: true, value: undefined };
    },

    delete(id: string): Result<boolean, KoiError> {
      return { ok: true, value: map.delete(id) };
    },

    has(id: string): Result<boolean, KoiError> {
      return { ok: true, value: map.has(id) };
    },

    size(): number {
      return map.size;
    },

    entries(): IterableIterator<readonly [string, Session]> {
      return map.entries() as IterableIterator<readonly [string, Session]>;
    },
  };
}
