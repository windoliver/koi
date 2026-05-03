/**
 * Turn-scoped lazy cache for the user-model snapshot.
 *
 * The cache is invalidated at the start of every turn (when new signals
 * may have arrived) and rebuilt on first read of `wrapModelCall`. Keeping
 * it lazy means turns that never reach `wrapModelCall` (e.g. blocked by
 * a stop gate) skip the work entirely.
 */

import type { UserSnapshot } from "@koi/core";

export type SnapshotBuilder = () => Promise<UserSnapshot>;

export interface SnapshotCache {
  readonly get: () => Promise<UserSnapshot>;
  readonly invalidate: () => void;
}

export function createSnapshotCache(build: SnapshotBuilder): SnapshotCache {
  let cached: Promise<UserSnapshot> | null = null;
  return {
    get(): Promise<UserSnapshot> {
      if (cached === null) cached = build();
      return cached;
    },
    invalidate(): void {
      cached = null;
    },
  };
}
