import type { Tool } from "@koi/core";
import { createSpawnResultCache } from "./spawn-result-cache.js";
import { createAgentSpawnTool } from "./tools/agent-spawn.js";
import type { SpawnToolsConfig } from "./types.js";

/**
 * createSpawnTools — factory that returns spawn tools for coordinator agents.
 *
 * Returns [agent_spawn].
 *
 * Provisions a default `SpawnResultCache` if the caller did not supply one,
 * so idempotent retry dedup is on by default. The cache only activates when
 * a spawn carries `context.task_id`, so spawns without a task identity are
 * unaffected. Pass an explicit `resultCache` to share a single cache across
 * multiple `createSpawnTools` calls in the same session, or pass `null` (via
 * a wrapper) if a future caller needs to opt out.
 */
export function createSpawnTools(config: SpawnToolsConfig): readonly Tool[] {
  const resultCache = config.resultCache ?? createSpawnResultCache();
  return [createAgentSpawnTool({ ...config, resultCache })];
}
