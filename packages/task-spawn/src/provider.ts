/**
 * ComponentProvider that attaches the task tool to an agent.
 */

import { createSingleToolProvider } from "@koi/core";
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
  return createSingleToolProvider({
    name: "task-spawn",
    toolName: "task",
    createTool: () => createTaskTool(config),
  });
}
