/**
 * Koi Tool → pi AgentTool bridge.
 *
 * Wraps each Koi tool on the agent entity as a pi AgentTool, routing
 * execute() calls through callHandlers.toolCall() for middleware interposition.
 */

import type { JsonObject } from "@koi/core/common";
import type { Agent, Tool, ToolDescriptor } from "@koi/core/ecs";
import type { ToolHandler } from "@koi/core/middleware";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { TSchema } from "@sinclair/typebox";

/**
 * Convert a Koi ToolDescriptor's JSON Schema to a TypeBox TSchema.
 * At runtime, TypeBox TSchema IS JSON Schema — this is a documented identity cast
 * at the boundary between Koi's JsonObject schema and pi's TypeBox schema.
 * @see https://github.com/sinclairzx81/typebox#json-schema
 */
function jsonSchemaToTSchema(schema: JsonObject): TSchema {
  // Boundary cast: JsonObject ⊂ JSON Schema ≡ TSchema at runtime
  return schema as unknown as TSchema;
}

/**
 * Format a tool result value into an AgentToolResult.
 * Converts the output to a text content block with JSON serialization.
 */
function formatToolResult(output: unknown): AgentToolResult<unknown> {
  const text = typeof output === "string" ? output : JSON.stringify(output, null, 2);
  return {
    content: [{ type: "text", text }],
    details: output,
  };
}

/**
 * Wrap a single Koi Tool as a pi AgentTool.
 * The execute function routes through callHandlers.toolCall() for middleware.
 */
function wrapTool(descriptor: ToolDescriptor, toolCall: ToolHandler): AgentTool {
  return {
    name: descriptor.name,
    description: descriptor.description,
    label: descriptor.name,
    parameters: jsonSchemaToTSchema(descriptor.inputSchema),
    execute: async (toolCallId: string, params: unknown): Promise<AgentToolResult<unknown>> => {
      // Validate params at the boundary — pi passes unknown from LLM JSON parsing
      const input =
        typeof params === "object" && params !== null && !Array.isArray(params)
          ? (params as JsonObject)
          : {};
      const response = await toolCall({
        toolId: descriptor.name,
        input,
        metadata: { toolCallId },
      });
      return formatToolResult(response.output);
    },
  };
}

/**
 * Extract all tools from a Koi Agent entity and wrap them as pi AgentTools.
 * Routes tool execution through the provided toolCall handler for middleware.
 */
export function createPiTools(agent: Agent, toolCall: ToolHandler): readonly AgentTool[] {
  const toolComponents = agent.query<Tool>("tool:");
  const tools: AgentTool[] = [];

  for (const [_token, tool] of toolComponents) {
    tools.push(wrapTool(tool.descriptor, toolCall));
  }

  return tools;
}
