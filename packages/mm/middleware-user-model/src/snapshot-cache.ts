/**
 * Turn-scoped lazy snapshot cache with eager invalidation.
 *
 * The cache is invalidated when new signals are ingested, ensuring
 * the next snapshot computation reflects the latest state.
 */

import type { UserSnapshot } from "@koi/core/user-model";

export interface SnapshotCache {
  readonly get: () => UserSnapshot | undefined;
  readonly set: (snapshot: UserSnapshot) => void;
  readonly invalidate: () => void;
}

export function createSnapshotCache(): SnapshotCache {
  let cached: UserSnapshot | undefined; // let: mutable cache slot

  return {
    get(): UserSnapshot | undefined {
      return cached;
    },
    set(snapshot: UserSnapshot): void {
      cached = snapshot;
    },
    invalidate(): void {
      cached = undefined;
    },
  };
}
