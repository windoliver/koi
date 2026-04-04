import type { Tool } from "@koi/core";
import { createAgentSpawnTool } from "./tools/agent-spawn.js";
import type { SpawnToolsConfig } from "./types.js";

/**
 * createSpawnTools — factory that returns spawn tools for coordinator agents.
 *
 * Returns [agent_spawn].
 */
export function createSpawnTools(config: SpawnToolsConfig): readonly Tool[] {
  return [createAgentSpawnTool(config)];
}
