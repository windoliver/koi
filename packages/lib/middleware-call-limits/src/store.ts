/**
 * In-memory call limit store — Map-backed atomic counter.
 *
 * Bun/Node are single-threaded; synchronous operations are atomic between
 * await points. `incrementIfBelow` therefore needs no locking.
 */

import type { CallLimitStore, IncrementIfBelowResult } from "./types.js";

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

    decrement(key: string): number {
      const current = counts.get(key) ?? 0;
      const next = Math.max(0, current - 1);
      if (next === 0) {
        counts.delete(key);
      } else {
        counts.set(key, next);
      }
      return next;
    },

    reset(key: string): void {
      counts.delete(key);
    },

    incrementIfBelow(key: string, limit: number): IncrementIfBelowResult {
      const current = counts.get(key) ?? 0;
      if (current >= limit) {
        return { allowed: false, current };
      }
      const next = current + 1;
      counts.set(key, next);
      return { allowed: true, current: next };
    },
  };
}
