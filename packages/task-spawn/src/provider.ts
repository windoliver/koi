/**
 * ComponentProvider that attaches the task tool to an agent.
 */

import type { ComponentProvider } from "@koi/core/ecs";
import { createTaskTool } from "./task-tool.js";
import type { TaskSpawnConfig } from "./types.js";

/**
 * Creates a ComponentProvider that attaches a single `tool:task` component.
 *
 * The tool is created once and cached — subsequent attach() calls return
 * the same tool instance.
 */
export function createTaskSpawnProvider(config: TaskSpawnConfig): ComponentProvider {
  // let justified: mutable cache (set once on first attach)
  let cached: ReadonlyMap<string, unknown> | undefined;

  return {
    name: "task-spawn",

    async attach(): Promise<ReadonlyMap<string, unknown>> {
      if (cached !== undefined) return cached;

      const tool = createTaskTool(config);
      const components = new Map<string, unknown>();
      components.set("tool:task", tool);
      cached = components;
      return cached;
    },
  };
}
