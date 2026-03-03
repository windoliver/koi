/**
 * Spawn adapter — maps unified SpawnFn to SpawnWorkerFn.
 *
 * Bridges the L0 unified spawn interface (Decision 5B) with
 * the orchestrator package-specific SpawnWorkerFn signature.
 */

import type { SpawnFn } from "@koi/core";
import { agentId as brandAgentId } from "@koi/core";
import type { SpawnWorkerFn, SpawnWorkerRequest, SpawnWorkerResult } from "./types.js";

/**
 * Adapt a unified SpawnFn into a SpawnWorkerFn.
 *
 * Maps SpawnWorkerRequest → SpawnRequest (adds taskId, agentId) and
 * SpawnResult → SpawnWorkerResult (KoiError passes through directly).
 */
export function mapSpawnToWorker(spawn: SpawnFn, agentName: string): SpawnWorkerFn {
  return async (request: SpawnWorkerRequest): Promise<SpawnWorkerResult> => {
    const result = await spawn({
      description: request.description,
      agentName,
      signal: request.signal,
      taskId: request.taskId,
      agentId: request.agentId !== undefined ? brandAgentId(request.agentId) : undefined,
    });

    return result;
  };
}
