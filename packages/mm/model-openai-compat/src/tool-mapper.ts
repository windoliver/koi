/**
 * Map Koi ToolDescriptor → OpenAI Chat Completions function tool format.
 */

import type { ToolDescriptor } from "@koi/core";
import type { ChatCompletionTool, ResolvedCompat } from "./types.js";

export function mapToolDescriptors(
  tools: readonly ToolDescriptor[],
  compat: ResolvedCompat,
): readonly ChatCompletionTool[] {
  // Sort alphabetically for prompt-cache stability: deterministic tool order
  // means the tools section of the request body is identical across turns,
  // preserving the provider's KV cache prefix (#1554).
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  return sorted.map((tool) => ({
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
