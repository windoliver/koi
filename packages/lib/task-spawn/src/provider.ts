/**
 * ComponentProvider that attaches the task tool to an agent.
 */

import type { Agent, ComponentProvider } from "@koi/core";
import { toolToken } from "@koi/core";
import { createTaskTool } from "./task-tool.js";
import type { TaskSpawnConfig } from "./types.js";

export function createTaskSpawnProvider(config: TaskSpawnConfig): ComponentProvider {
  // let justified: cache populated on first attach
  let cached: ReadonlyMap<string, unknown> | undefined;

  return {
    name: "task-spawn",

    async attach(_agent: Agent): Promise<ReadonlyMap<string, unknown>> {
      if (cached !== undefined) return cached;
      const tool = await createTaskTool(config);
      const components = new Map<string, unknown>();
      components.set(toolToken("task") as string, tool);
      cached = components;
      return cached;
    },
  };
}
