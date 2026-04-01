/**
 * Map Koi ToolDescriptor → OpenAI Chat Completions function tool format.
 */

import type { ToolDescriptor } from "@koi/core";
import type { ChatCompletionTool, ResolvedCompat } from "./types.js";

export function mapToolDescriptors(
  tools: readonly ToolDescriptor[],
  compat: ResolvedCompat,
): readonly ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      // Some providers reject the `strict` field — only include when supported
      ...(compat.supportsStrictMode ? { strict: false } : {}),
    },
  }));
}
