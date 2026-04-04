/**
 * Shared types for @koi/spawn-tools.
 */

import type { AgentId, ManagedTaskBoard, SpawnFn } from "@koi/core";

export interface SpawnToolsConfig {
  readonly spawnFn: SpawnFn;
  readonly board: ManagedTaskBoard;
  readonly agentId: AgentId;
  readonly signal: AbortSignal;
}
