/**
 * Lightweight JSON Schema validation for tool arguments.
 *
 * Validates required fields, top-level property types, and
 * additionalProperties constraints. Does not handle nested schemas,
 * oneOf/anyOf/allOf, or format validators — those require a full
 * JSON Schema library (e.g., Ajv) if/when one is added as a dependency.
 */

import type { JsonObject, ToolDescriptor } from "@koi/core";

/**
 * Allowlisted schema keywords this validator can evaluate.
 * Any keyword NOT in this set is rejected (fail-closed).
 */
const SUPPORTED_ROOT_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "description",
  "title",
  "$schema",
  "$id",
  "default",
]);

const SUPPORTED_PROPERTY_KEYWORDS = new Set([
  "type",
  "description",
  "title",
  "default",
  // Structural keywords for arrays/objects — recognized but not deeply validated.
  // The validator only checks top-level property types; nested schema contents
  // (item shapes, nested required, nested properties) are not evaluated.
  "items",
  "properties",
  "required",
  // String/number constraints — recognized (checked by the model), not validated.
  // Zod's toJSONSchema emits these for z.string().min(1), z.enum([...]), etc.
  "minLength",
  "maxLength",
  "enum",
  "pattern",
  "minimum",
  "maximum",
  // additionalProperties at the property level (nested objects)
  "additionalProperties",
]);

/**
 * Validate tool arguments against the descriptor's inputSchema.
 * Returns an error string on failure, undefined on success.
 *
 * Fails closed on unsupported schema keywords — if the schema uses
 * features this validator cannot evaluate, the tool call is rejected
 * rather than silently bypassed.
 */
export function validateToolArgs(args: JsonObject, descriptor: ToolDescriptor): string | undefined {
  const schema = descriptor.inputSchema;

  // Fail closed on any root keyword not in the supported allowlist
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_ROOT_KEYWORDS.has(key)) {
      return `schema uses unsupported keyword "${key}" — cannot validate safely`;
    }
  }

  // Check required fields
  const required = schema.required;
  if (Array.isArray(required)) {
    const missing = required.filter((field) => typeof field === "string" && !(field in args));
    if (missing.length > 0) {
      return `missing required field(s): ${missing.join(", ")}`;
    }
  }

  // Check property types when schema.properties is defined
  const properties = schema.properties;
  if (typeof properties === "object" && properties !== null) {
    for (const [key, schemaDef] of Object.entries(properties)) {
      if (!(key in args)) continue; // missing fields are caught by required check
      const value = args[key];
      if (typeof schemaDef === "object" && schemaDef !== null) {
        // Fail closed on any property keyword not in the supported allowlist
        for (const kw of Object.keys(schemaDef)) {
          if (!SUPPORTED_PROPERTY_KEYWORDS.has(kw)) {
            return `property "${key}" uses unsupported keyword "${kw}" — cannot validate safely`;
          }
        }
        if ("type" in schemaDef) {
          const error = checkType(key, value, String(schemaDef.type));
          if (error !== undefined) return error;
        }
      }
    }
  }

  // Check additionalProperties
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
    if (typeof schema.additionalProperties === "object" && schema.additionalProperties !== null) {
      // additionalProperties as a subschema — cannot validate, fail closed
      return 'schema uses "additionalProperties" as a subschema — cannot validate safely';
    }
    if (schema.additionalProperties === false) {
      // When properties is absent, no keys are allowed (empty allowed set)
      const allowed =
        typeof properties === "object" && properties !== null
          ? new Set(Object.keys(properties))
          : new Set<string>();
      const extra = Object.keys(args).filter((k) => !allowed.has(k));
      if (extra.length > 0) {
        return `unexpected additional field(s): ${extra.join(", ")}`;
      }
    }
  }

  return undefined;
}

function checkType(key: string, value: unknown, expectedType: string): string | undefined {
  switch (expectedType) {
    case "string":
      if (typeof value !== "string") return `field "${key}" expected string, got ${typeof value}`;
      break;
    case "number":
    case "integer":
      if (typeof value !== "number")
        return `field "${key}" expected ${expectedType}, got ${typeof value}`;
      if (expectedType === "integer" && !Number.isInteger(value))
        return `field "${key}" expected integer, got float`;
      break;
    case "boolean":
      if (typeof value !== "boolean") return `field "${key}" expected boolean, got ${typeof value}`;
      break;
    case "array":
      if (!Array.isArray(value)) return `field "${key}" expected array, got ${typeof value}`;
      break;
    case "object":
      if (typeof value !== "object" || value === null || Array.isArray(value))
        return `field "${key}" expected object, got ${Array.isArray(value) ? "array" : typeof value}`;
      break;
    case "null":
      if (value !== null) return `field "${key}" expected null, got ${typeof value}`;
      break;
    default:
      return `field "${key}" has unsupported type "${expectedType}" — cannot validate safely`;
  }
  return undefined;
}
