/**
 * In-memory call limit store — Map-backed, sync returns.
 */

import type { CallLimitStore } from "./types.js";

/**
 * Creates a Map-backed call limit store.
 * All operations are synchronous (no async overhead for the common case).
 */
export function createInMemoryCallLimitStore(): CallLimitStore {
  const counts = new Map<string, number>();

  return {
    get(key: string): number {
      return counts.get(key) ?? 0;
    },

    increment(key: string): number {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },

    reset(key: string): void {
      counts.delete(key);
    },
  };
}
