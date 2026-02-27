/**
 * ComponentProvider that attaches the parallel_task tool to an agent.
 */

import { createSingleToolProvider } from "@koi/core";
import type { ComponentProvider } from "@koi/core/ecs";
import { createParallelTool } from "./parallel-tool.js";
import type { ParallelMinionsConfig } from "./types.js";

/**
 * Creates a ComponentProvider that attaches a single `tool:parallel_task` component.
 *
 * The tool is created once and cached — subsequent attach() calls return
 * the same tool instance.
 */
export function createParallelMinionsProvider(config: ParallelMinionsConfig): ComponentProvider {
  return createSingleToolProvider({
    name: "parallel-minions",
    toolName: "parallel_task",
    createTool: () => createParallelTool(config),
  });
}
