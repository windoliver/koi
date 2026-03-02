/**
 * Per-session preference cache with invalidation.
 */

import type { MemoryResult } from "@koi/core/ecs";

export interface PreferenceCache {
  readonly get: () => readonly MemoryResult[] | undefined;
  readonly set: (preferences: readonly MemoryResult[]) => void;
  readonly invalidate: () => void;
}

export function createPreferenceCache(): PreferenceCache {
  let cached: readonly MemoryResult[] | undefined; // let: mutable cache slot

  return {
    get(): readonly MemoryResult[] | undefined {
      return cached;
    },
    set(preferences: readonly MemoryResult[]): void {
      cached = preferences;
    },
    invalidate(): void {
      cached = undefined;
    },
  };
}
