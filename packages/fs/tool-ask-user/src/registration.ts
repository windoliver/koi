/**
 * ToolRegistration for @koi/tool-ask-user — self-describing registration descriptor.
 *
 * Exports a factory that creates a ToolRegistration given an AskUserConfig.
 * This is the simplest registration — just one tool, no prefix/operations pattern.
 *
 * Usage in a manifest:
 *   tools:
 *     - name: ask_user
 *       package: "@koi/tool-ask-user"
 */

import type { ToolRegistration } from "@koi/core";
import { createAskUserTool } from "./ask-user-tool.js";
import type { AskUserConfig } from "./types.js";

/**
 * Create a ToolRegistration for the ask_user tool.
 *
 * Call this with an AskUserConfig and export the result as `registration`.
 * The engine's auto-resolution will pick it up from the `package` field.
 */
export function createAskUserRegistration(config: AskUserConfig): ToolRegistration {
  return {
    name: "ask-user",
    tools: [
      {
        name: "ask_user",
        create: () => createAskUserTool(config),
      },
    ],
  };
}
