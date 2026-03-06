/**
 * Spawn adapter — maps unified SpawnFn to MinionSpawnFn.
 *
 * Bridges the L0 unified spawn interface (Decision 5B) with
 * the parallel-minions package-specific MinionSpawnFn signature.
 */

import type { SpawnFn } from "@koi/core";
import type { MinionSpawnFn, MinionSpawnRequest, MinionSpawnResult } from "./types.js";

/**
 * Adapt a unified SpawnFn into a MinionSpawnFn.
 *
 * Maps MinionSpawnRequest → SpawnRequest (adds taskIndex) and
 * SpawnResult → MinionSpawnResult (maps KoiError → string).
 */
export function mapSpawnToMinion(spawn: SpawnFn): MinionSpawnFn {
  return async (request: MinionSpawnRequest): Promise<MinionSpawnResult> => {
    const result = await spawn({
      description: request.description,
      agentName: request.agentName,
      manifest: request.manifest,
      signal: request.signal,
      taskIndex: request.taskIndex,
      ...(request.delivery !== undefined ? { delivery: request.delivery } : {}),
    });

    if (result.ok) {
      return { ok: true, output: result.output };
    }
    return { ok: false, error: result.error.message };
  };
}
