/**
 * ComponentProvider that attaches the ask_guide tool to an agent.
 */

import { createSingleToolProvider } from "@koi/core";
import type { ComponentProvider } from "@koi/core/ecs";
import { createAskGuideTool } from "./ask-guide-tool.js";
import type { AskGuideConfig } from "./types.js";

/**
 * Creates a ComponentProvider that attaches a single `tool:ask_guide` component.
 *
 * The tool is created once and cached — subsequent attach() calls return
 * the same tool instance.
 */
export function createAskGuideProvider(config: AskGuideConfig): ComponentProvider {
  return createSingleToolProvider({
    name: "ask-guide",
    toolName: "ask_guide",
    createTool: () => createAskGuideTool(config),
  });
}
