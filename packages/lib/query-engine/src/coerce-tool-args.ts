/**
 * Shallow type coercion for tool call arguments.
 *
 * Models (especially weaker ones) sometimes send string values where the
 * tool schema declares numeric or boolean types. This function coerces
 * top-level string values to the declared JSON Schema type before validation.
 *
 * Only coerces when the conversion is unambiguous — non-coercible values
 * pass through unchanged so downstream validation can report the real error.
 */

import type { JsonObject } from "@koi/core";

/**
 * Coerce top-level string values in `args` to match the types declared
 * in `schema.properties`. Returns a new object (never mutates input).
 *
 * Coercion rules (shallow, top-level only):
 * - string → number/integer: via `Number()`, skipped if `NaN`
 * - string → boolean: `"true"` → `true`, `"false"` → `false`, else skipped
 * - All other cases: value passed through unchanged
 */
export function coerceToolArgs(args: JsonObject, schema: JsonObject): JsonObject {
  const properties = schema.properties;
  if (typeof properties !== "object" || properties === null) return args;

  const props = properties as Record<string, Record<string, unknown>>;
  // let justified: mutable flag to avoid cloning when no coercion occurs
  let coerced: Record<string, unknown> | undefined;

  for (const [key, prop] of Object.entries(props)) {
    if (!(key in args)) continue;
    const value = args[key];
    if (typeof value !== "string") continue;
    if (typeof prop !== "object" || prop === null) continue;

    const schemaType = prop.type;
    if (typeof schemaType !== "string" || schemaType === "string") continue;

    const converted = coerceStringValue(value, schemaType);
    if (converted !== undefined) {
      if (coerced === undefined) {
        coerced = { ...args };
      }
      coerced[key] = converted;
    }
  }

  return (coerced as JsonObject | undefined) ?? args;
}

function coerceStringValue(value: string, targetType: string): unknown | undefined {
  switch (targetType) {
    case "number":
    case "integer": {
      if (value.trim() === "") return undefined;
      const n = Number(value);
      if (!Number.isFinite(n)) return undefined;
      if (targetType === "integer" && !Number.isInteger(n)) return undefined;
      return n;
    }
    case "boolean":
      if (value === "true") return true;
      if (value === "false") return false;
      return undefined;
    default:
      return undefined;
  }
}
