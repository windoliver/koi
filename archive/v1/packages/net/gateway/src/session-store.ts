/**
 * SessionStore: pluggable session persistence.
 * Default in-memory implementation provided.
 *
 * Interface re-exported from @koi/gateway-types for backward compatibility.
 */

import type { KoiError, Result } from "@koi/core";
import { notFound } from "@koi/core";
import type { Session } from "./types.js";

// Re-export interface from @koi/gateway-types
export type { SessionStore } from "@koi/gateway-types";

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

export function createInMemorySessionStore(): import("@koi/gateway-types").SessionStore {
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
