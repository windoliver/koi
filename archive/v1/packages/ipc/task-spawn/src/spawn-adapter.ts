/**
 * Spawn adapter — maps unified SpawnFn to task-spawn's SpawnFn.
 *
 * Bridges the L0 unified spawn interface (Decision 5B) with
 * the task-spawn package-specific SpawnFn signature.
 */

import type { SpawnFn as UnifiedSpawnFn } from "@koi/core";
import type { SpawnFn as TaskSpawnFn, TaskSpawnRequest, TaskSpawnResult } from "./types.js";

/**
 * Adapt a unified SpawnFn into a task-spawn SpawnFn.
 *
 * Maps TaskSpawnRequest → SpawnRequest and SpawnResult → TaskSpawnResult
 * (maps KoiError → string for error field).
 */
export function mapSpawnToTask(spawn: UnifiedSpawnFn): TaskSpawnFn {
  return async (request: TaskSpawnRequest): Promise<TaskSpawnResult> => {
    const result = await spawn({
      description: request.description,
      agentName: request.agentName,
      manifest: request.manifest,
      signal: request.signal,
      ...(request.delivery !== undefined ? { delivery: request.delivery } : {}),
    });

    if (result.ok) {
      return { ok: true, output: result.output };
    }
    return { ok: false, error: result.error.message };
  };
}
