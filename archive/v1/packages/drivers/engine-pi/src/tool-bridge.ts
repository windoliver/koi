/**
 * Koi Tool → pi AgentTool bridge.
 *
 * Wraps each Koi tool on the agent entity as a pi AgentTool, routing
 * execute() calls through callHandlers.toolCall() for middleware interposition.
 */

import type { JsonObject } from "@koi/core/common";
import type { Agent, Tool, ToolDescriptor } from "@koi/core/ecs";
import type { ToolHandler } from "@koi/core/middleware";
import { formatToolError } from "@koi/errors";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { TSchema } from "@sinclair/typebox";
import { PARSE_ERROR_KEY } from "./stream-bridge.js";

/** Maximum length for Anthropic API tool names. */
const MAX_TOOL_NAME_LENGTH = 64;

/**
 * Sanitize a Koi tool name for the Anthropic API.
 * The API requires tool names matching `^[a-zA-Z0-9_-]{1,64}$`.
 * Replaces invalid characters (e.g., `/` in `lsp/ts/hover`) with `_`.
 * Throws if the sanitized name exceeds 64 characters.
 */
export function sanitizeToolName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (sanitized.length > MAX_TOOL_NAME_LENGTH) {
    throw new Error(
      `Tool name "${name}" exceeds ${String(MAX_TOOL_NAME_LENGTH)} characters after sanitization ` +
        `(${String(sanitized.length)} chars). Use a shorter tool name.`,
    );
  }
  return sanitized;
}

/**
 * Recursively ensure every property in a JSON Schema has a `type` field.
 * The Anthropic API rejects schemas with typeless properties (e.g., `{}`).
 * Properties without a `type` get `type: "object"` as a safe default.
 */
function sanitizeSchema(schema: JsonObject): JsonObject {
  if (typeof schema !== "object" || schema === null) return schema;

  const result = { ...schema };

  // If this is a property-level object with no type, add one
  if (
    result.properties === undefined &&
    result.type === undefined &&
    result.description !== undefined
  ) {
    result.type = "object";
  }

  // If this is just `{}` (empty schema), make it a valid object schema
  if (Object.keys(result).length === 0) {
    return { type: "object" };
  }

  // Recurse into properties
  if (result.properties !== undefined && typeof result.properties === "object") {
    const props = result.properties as Record<string, JsonObject>;
    const sanitized: Record<string, JsonObject> = {};
    for (const [key, value] of Object.entries(props)) {
      if (typeof value === "object" && value !== null) {
        const prop = value as Record<string, unknown>;
        // Ensure every property has a type
        if (prop.type === undefined) {
          sanitized[key] = { type: "object", ...prop } as JsonObject;
        } else {
          sanitized[key] = sanitizeSchema(value);
        }
      } else if (typeof value === "string") {
        // Raw string value instead of schema object (e.g., origin: "primordial")
        sanitized[key] = { type: "string" } as JsonObject;
      } else {
        sanitized[key] = value;
      }
    }
    result.properties = sanitized;
  }

  // Recurse into items
  if (result.items !== undefined && typeof result.items === "object") {
    result.items = sanitizeSchema(result.items as JsonObject);
  }

  return result;
}

/**
 * Convert a Koi ToolDescriptor's JSON Schema to a TypeBox TSchema.
 * Sanitizes the schema to ensure Anthropic API compatibility (all
 * properties must have `type` fields per JSON Schema draft 2020-12).
 * @see https://github.com/sinclairzx81/typebox#json-schema
 */
function jsonSchemaToTSchema(schema: JsonObject): TSchema {
  const sanitized = sanitizeSchema(schema);
  // Boundary cast: JsonObject ⊂ JSON Schema ≡ TSchema at runtime
  return sanitized as unknown as TSchema;
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
export function wrapTool(descriptor: ToolDescriptor, toolCall: ToolHandler): AgentTool {
  return {
    name: sanitizeToolName(descriptor.name),
    description: descriptor.description,
    label: descriptor.name,
    parameters: jsonSchemaToTSchema(descriptor.inputSchema),
    execute: async (toolCallId: string, params: unknown): Promise<AgentToolResult<unknown>> => {
      // Validate params at the boundary — pi passes unknown from LLM JSON parsing
      const input =
        typeof params === "object" && params !== null && !Array.isArray(params)
          ? (params as JsonObject)
          : {};

      // Check for deferred parse error from stream-bridge.
      // Throw BEFORE the defense-in-depth catch so the error propagates to
      // pi runtime, which converts it to a tool error response for the model.
      //
      // This error intentionally bypasses the defense-in-depth catch below.
      // Pi runtime sends the error message back to the model, which can then
      // produce valid JSON on the next turn. Semantic-retry's wrapModelCall
      // on subsequent turns handles the retry flow.
      const parseErrorMsg = input[PARSE_ERROR_KEY];
      if (typeof parseErrorMsg === "string") {
        throw Object.freeze({
          code: "VALIDATION" as const,
          message: parseErrorMsg,
          retryable: false,
          context: { toolName: descriptor.name },
        });
      }

      try {
        const response = await toolCall({
          toolId: descriptor.name,
          input,
          metadata: { toolCallId },
        });
        return formatToolResult(response.output);
      } catch (error: unknown) {
        // Defense-in-depth: catch errors that bypass middleware and return a
        // structured error result instead of letting pi runtime handle it opaquely.
        const text = formatToolError(error, descriptor.name);
        return { content: [{ type: "text", text }], details: { error: text } };
      }
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
