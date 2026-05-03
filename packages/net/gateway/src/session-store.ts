/**
 * SessionStore: in-memory implementation. The interface itself lives in
 * @koi/gateway-types so peer L2 packages (gateway-nexus, gateway-stack)
 * can implement/inject it without an L2→L2 dependency.
 */

import type { KoiError, Result } from "@koi/core";
import { notFound } from "@koi/core";
import type { Session, SessionStore } from "@koi/gateway-types";

export type { SessionStore };

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
