import type { ProcEntry } from "@koi/core";

export function middlewareEntry(_agent: unknown): ProcEntry {
  return {
    read: () => {
      // No public enumeration API for middleware; fall back to empty array
      // The middleware tokens exist but are queried with agent.query<T>(prefix),
      // which requires knowing the type T at compile time. Without a public
      // middleware registry, we return [] with a comment.
      return [];
    },
    list: () => {
      return [];
    },
  };
}
