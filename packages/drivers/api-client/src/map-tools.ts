/**
 * Map Koi ToolDescriptor[] to Anthropic SDK Tool format.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { ToolDescriptor } from "@koi/core";

/** Convert Koi tool descriptors to Anthropic tool parameters. */
export function toAnthropicTools(tools: readonly ToolDescriptor[]): readonly Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));
}
