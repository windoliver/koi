/**
 * ComponentProvider that attaches the parallel_task tool to an agent.
 */

import type { Agent, ComponentProvider } from "@koi/core/ecs";
import { createParallelTool } from "./parallel-tool.js";
import type { ParallelMinionsConfig } from "./types.js";

/**
 * Creates a ComponentProvider that attaches a single `tool:parallel_task` component.
 *
 * The tool is created once and cached — subsequent attach() calls return
 * the same tool instance.
 */
export function createParallelMinionsProvider(config: ParallelMinionsConfig): ComponentProvider {
  // let justified: mutable cache (set once on first attach)
  let cached: ReadonlyMap<string, unknown> | undefined;

  return {
    name: "parallel-minions",

    async attach(_agent: Agent): Promise<ReadonlyMap<string, unknown>> {
      if (cached !== undefined) return cached;

      const tool = createParallelTool(config);
      const components = new Map<string, unknown>();
      components.set("tool:parallel_task", tool);
      cached = components;
      return cached;
    },
  };
}
