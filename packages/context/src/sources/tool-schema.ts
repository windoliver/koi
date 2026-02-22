/**
 * Tool schema source resolver — serializes tool descriptors for context.
 */

import type { Agent, Tool } from "@koi/core";
import type { SourceResult, ToolSchemaSource } from "../types.js";

/** Resolves a tool_schema source by querying the agent's tool components. */
export function resolveToolSchemaSource(
  source: ToolSchemaSource,
  agent: Agent,
): Promise<SourceResult> {
  const tools = agent.query<Tool>("tool:");
  const result = [...tools.values()]
    .filter((tool) => {
      if (source.tools === undefined || source.tools.length === 0) {
        return true;
      }
      return source.tools.includes(tool.descriptor.name);
    })
    .map((tool) => ({
      name: tool.descriptor.name,
      description: tool.descriptor.description,
      inputSchema: tool.descriptor.inputSchema,
    }));

  const content = result.length > 0 ? JSON.stringify(result, null, 2) : "No tools available.";

  return Promise.resolve({
    label: source.label ?? "Tool Schemas",
    content,
    tokens: 0,
    source,
  });
}
