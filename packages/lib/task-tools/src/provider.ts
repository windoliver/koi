/**
 * ComponentProvider wrapping task tools for ECS agent assembly.
 *
 * Uses createToolComponentProvider from @koi/tools-core to bundle all 7 task
 * tools under their toolToken keys.
 */

import type { ComponentProvider } from "@koi/core";
import { COMPONENT_PRIORITY } from "@koi/core";
import { createToolComponentProvider } from "@koi/tools-core";
import { createTaskTools } from "./create-task-tools.js";
import type { TaskToolsConfig } from "./types.js";

export interface TaskToolsProviderConfig extends TaskToolsConfig {
  /** Assembly priority. Defaults to COMPONENT_PRIORITY.BUNDLED. */
  readonly priority?: number | undefined;
}

export function createTaskToolsProvider(config: TaskToolsProviderConfig): ComponentProvider {
  const tools = createTaskTools(config);
  return createToolComponentProvider({
    name: "task-tools",
    tools,
    priority: config.priority ?? COMPONENT_PRIORITY.BUNDLED,
  });
}
