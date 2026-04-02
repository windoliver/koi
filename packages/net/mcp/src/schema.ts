/**
 * Schema normalization — ensures MCP tool schemas are valid JSON Schema.
 *
 * MCP tool schemas in the wild are messy: bare objects without `type: "object"`,
 * missing `properties` keys, non-object root types. This module normalizes all
 * inbound schemas before they reach ToolDescriptor.inputSchema.
 */

import type { JsonObject } from "@koi/core";

/**
 * Normalizes a raw MCP tool input schema to a valid JSON Schema object.
 *
 * Guarantees:
 * - Result always has `type: "object"`
 * - Result always has `properties` (at minimum `{}`)
 * - `anyOf`/`oneOf` at root are preserved as-is (valid JSON Schema)
 * - Non-object input is wrapped in a sensible default
 */
export function normalizeToolSchema(raw: unknown): JsonObject {
  if (raw === undefined || raw === null) {
    return { type: "object", properties: {} };
  }

  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { type: "object", properties: {} };
  }

  const schema = raw as Record<string, unknown>;

  // Schemas with anyOf/oneOf at root are valid JSON Schema combinators — pass through
  if (schema.anyOf !== undefined || schema.oneOf !== undefined) {
    return schema as JsonObject;
  }

  const result: Record<string, unknown> = { ...schema };

  // Ensure type: "object" is present
  if (result.type === undefined) {
    result.type = "object";
  }

  // For object types, ensure properties exists
  if (result.type === "object" && result.properties === undefined) {
    result.properties = {};
  }

  return result as JsonObject;
}
