/**
 * Lane-aware concurrency gate — composes a global semaphore with
 * per-lane semaphores for independent concurrency budgets.
 *
 * Acquire order: lane-first, global-second (prevents holding a global
 * slot while blocked on a lane limit).
 * Release order: global-first, lane-second (reverse of acquire).
 */

import { createSemaphore } from "./semaphore.js";
import type { ConcurrencyGate, LaneConcurrency } from "./types.js";

/**
 * Creates a lane-aware concurrency gate.
 *
 * Without `laneConcurrency`, behaves identically to a plain semaphore.
 * With `laneConcurrency`, each configured lane gets an independent
 * concurrency budget, all capped by the global `maxConcurrency`.
 */
export function createLaneSemaphore(
  maxConcurrency: number,
  laneConcurrency?: LaneConcurrency | undefined,
): ConcurrencyGate {
  const global = createSemaphore(maxConcurrency);

  if (laneConcurrency === undefined || laneConcurrency.size === 0) {
    return {
      acquire: () => global.acquire(),
      release: () => global.release(),
      activeCount: () => global.activeCount(),
    };
  }

  const lanes = new Map(
    [...laneConcurrency.entries()].map(([key, limit]) => [key, createSemaphore(limit)]),
  );

  return {
    async acquire(lane?: string | undefined): Promise<void> {
      const laneSem = lane !== undefined ? lanes.get(lane) : undefined;
      if (laneSem !== undefined) {
        // Lane-first: block on lane limit before consuming a global slot
        await laneSem.acquire();
      }
      await global.acquire();
    },

    release(lane?: string | undefined): void {
      // Global-first (reverse of acquire order)
      global.release();
      const laneSem = lane !== undefined ? lanes.get(lane) : undefined;
      if (laneSem !== undefined) {
        laneSem.release();
      }
    },

    activeCount(lane?: string | undefined): number {
      const laneSem = lane !== undefined ? lanes.get(lane) : undefined;
      if (laneSem !== undefined) {
        return laneSem.activeCount();
      }
      return global.activeCount();
    },
  };
}
