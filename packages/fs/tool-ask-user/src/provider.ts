/**
 * ComponentProvider that attaches the ask_user tool to an agent.
 */

import { createSingleToolProvider } from "@koi/core";
import type { ComponentProvider } from "@koi/core/ecs";
import { createAskUserTool } from "./ask-user-tool.js";
import type { AskUserConfig } from "./types.js";

/**
 * Creates a ComponentProvider that attaches a single `tool:ask_user` component.
 *
 * The tool is created once and cached — subsequent attach() calls return
 * the same tool instance.
 */
export function createAskUserProvider(config: AskUserConfig): ComponentProvider {
  return createSingleToolProvider({
    name: "ask-user",
    toolName: "ask_user",
    createTool: () => createAskUserTool(config),
  });
}
