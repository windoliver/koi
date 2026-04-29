/**
 * Shared types for @koi/spawn-tools.
 */

import type { AgentId, ManagedTaskBoard, SpawnFn } from "@koi/core";
import type { SpawnResultCache } from "./spawn-result-cache.js";

export interface SpawnToolsConfig {
  readonly spawnFn: SpawnFn;
  readonly board: ManagedTaskBoard;
  readonly agentId: AgentId;
  readonly signal: AbortSignal;
  /**
   * Optional cache for idempotent agent_spawn delivery. When provided, retried
   * spawns with the same `(agentId, agent_name, context.task_id)` return the
   * cached output instead of re-invoking `spawnFn`. Without a cache, every call
   * spawns a fresh child. See `createSpawnResultCache`.
   */
  readonly resultCache?: SpawnResultCache;
}
