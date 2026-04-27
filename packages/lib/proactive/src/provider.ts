/**
 * ComponentProvider wrapping the proactive tools for ECS agent assembly.
 */

import type { ComponentProvider } from "@koi/core";
import { COMPONENT_PRIORITY } from "@koi/core";
import { createToolComponentProvider } from "@koi/tools-core";
import { createProactiveTools } from "./create-proactive-tools.js";
import type { ProactiveToolsProviderConfig } from "./types.js";

export function createProactiveToolsProvider(
  config: ProactiveToolsProviderConfig,
): ComponentProvider {
  const tools = createProactiveTools(config);
  return createToolComponentProvider({
    name: "proactive",
    tools,
    priority: config.priority ?? COMPONENT_PRIORITY.BUNDLED,
  });
}
