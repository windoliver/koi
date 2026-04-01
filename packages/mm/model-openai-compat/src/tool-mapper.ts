/**
 * Map Koi ToolDescriptor → OpenAI Chat Completions function tool format.
 */

import type { ToolDescriptor } from "@koi/core";
import type { ChatCompletionTool } from "./types.js";

export function mapToolDescriptors(
  tools: readonly ToolDescriptor[],
): readonly ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}
