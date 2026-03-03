/**
 * CDGP test case auto-generation from JSON Schema.
 *
 * Generates smoke test cases (no expectedOutput) from a tool's inputSchema,
 * treating it as a formal specification. Covers 5 strategies: minimal valid,
 * required-only, null variants, boundary values, and type coercion traps.
 *
 * Pure function — no side effects, no I/O, no sandbox calls.
 */

import type { TestCase } from "@koi/core";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GenerateTestCasesConfig {
  readonly maxTestCases: number;
}

const DEFAULT_CONFIG: GenerateTestCasesConfig = { maxTestCases: 20 } as const;

/**
 * Generate smoke test cases from a JSON Schema.
 *
 * @param schema - JSON Schema describing the tool's input format.
 * @param config - Optional generation configuration (cap, etc.).
 * @returns Readonly array of test cases (smoke tests — no expectedOutput).
 */
export function generateTestCases(
  schema: Readonly<Record<string, unknown>>,
  config?: GenerateTestCasesConfig,
): readonly TestCase[] {
  const cap = config?.maxTestCases ?? DEFAULT_CONFIG.maxTestCases;
  if (cap <= 0) return [];

  const cases: TestCase[] = [];

  // Strategy 1: Minimal valid input
  const minimal = generateMinimalValid(schema);
  cases.push({ name: "auto:minimal_valid", input: minimal });

  // Strategy 2: Required-only (only required fields, skip optional)
  const requiredOnly = generateRequiredOnly(schema);
  if (!shallowEqual(minimal, requiredOnly)) {
    cases.push({ name: "auto:required_only", input: requiredOnly });
  }

  // Strategy 3: Null/undefined variants for optional fields
  const nullVariants = generateNullVariants(schema);
  for (const variant of nullVariants) {
    if (cases.length >= cap) break;
    cases.push(variant);
  }

  // Strategy 4: Boundary values
  const boundaries = generateBoundaryValues(schema);
  for (const boundary of boundaries) {
    if (cases.length >= cap) break;
    cases.push(boundary);
  }

  // Strategy 5: Type coercion traps
  const traps = generateCoercionTraps(schema);
  for (const trap of traps) {
    if (cases.length >= cap) break;
    cases.push(trap);
  }

  return cases.slice(0, cap);
}

// ---------------------------------------------------------------------------
// Schema inspection helpers
// ---------------------------------------------------------------------------

function getSchemaType(schema: Readonly<Record<string, unknown>>): string | undefined {
  const t = schema.type;
  if (typeof t === "string") return t;
  return undefined;
}

function getProperties(
  schema: Readonly<Record<string, unknown>>,
): Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined {
  const props = schema.properties;
  if (props !== null && typeof props === "object" && !Array.isArray(props)) {
    return props as Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  }
  return undefined;
}

function getRequired(schema: Readonly<Record<string, unknown>>): readonly string[] {
  const req = schema.required;
  if (Array.isArray(req)) return req as readonly string[];
  return [];
}

function getEnumValues(schema: Readonly<Record<string, unknown>>): readonly unknown[] | undefined {
  const e = schema.enum;
  if (Array.isArray(e) && e.length > 0) return e as readonly unknown[];
  return undefined;
}

function getItems(
  schema: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined {
  const items = schema.items;
  if (items !== null && typeof items === "object" && !Array.isArray(items)) {
    return items as Readonly<Record<string, unknown>>;
  }
  return undefined;
}

function getFirstVariant(
  schema: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined {
  const oneOf = schema.oneOf;
  if (
    Array.isArray(oneOf) &&
    oneOf.length > 0 &&
    typeof oneOf[0] === "object" &&
    oneOf[0] !== null
  ) {
    return oneOf[0] as Readonly<Record<string, unknown>>;
  }
  const anyOf = schema.anyOf;
  if (
    Array.isArray(anyOf) &&
    anyOf.length > 0 &&
    typeof anyOf[0] === "object" &&
    anyOf[0] !== null
  ) {
    return anyOf[0] as Readonly<Record<string, unknown>>;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Minimal value generation for a given schema type
// ---------------------------------------------------------------------------

function generateMinimalValue(schema: Readonly<Record<string, unknown>>): unknown {
  // Handle enum first
  const enumVals = getEnumValues(schema);
  if (enumVals !== undefined) return enumVals[0];

  // Handle oneOf/anyOf — delegate to first variant
  const variant = getFirstVariant(schema);
  if (variant !== undefined) return generateMinimalValue(variant);

  const type = getSchemaType(schema);

  switch (type) {
    case "string": {
      const minLen = typeof schema.minLength === "number" ? schema.minLength : 0;
      return "a".repeat(minLen);
    }
    case "number":
    case "integer": {
      const min = typeof schema.minimum === "number" ? schema.minimum : undefined;
      const exMin =
        typeof schema.exclusiveMinimum === "number" ? schema.exclusiveMinimum : undefined;
      if (min !== undefined) return min;
      if (exMin !== undefined) return type === "integer" ? Math.ceil(exMin + 1) : exMin + 1;
      return 0;
    }
    case "boolean":
      return false;
    case "array": {
      const minItems = typeof schema.minItems === "number" ? schema.minItems : 0;
      const items = getItems(schema);
      if (minItems === 0) return [];
      const itemValue = items !== undefined ? generateMinimalValue(items) : null;
      return Array.from({ length: minItems }, () => itemValue);
    }
    case "object": {
      const props = getProperties(schema);
      if (props === undefined) return {};
      const required = getRequired(schema);
      const result: Record<string, unknown> = {};
      for (const key of required) {
        const propSchema = props[key];
        if (propSchema !== undefined) {
          result[key] = generateMinimalValue(propSchema);
        }
      }
      // Also include optional properties for "minimal valid"
      for (const [key, propSchema] of Object.entries(props)) {
        if (!(key in result)) {
          result[key] = generateMinimalValue(propSchema);
        }
      }
      return result;
    }
    case "null":
      return null;
    default:
      // No type specified or unknown type
      return {};
  }
}

// ---------------------------------------------------------------------------
// Strategy 1: Minimal valid input
// ---------------------------------------------------------------------------

function generateMinimalValid(schema: Readonly<Record<string, unknown>>): unknown {
  return generateMinimalValue(schema);
}

// ---------------------------------------------------------------------------
// Strategy 2: Required-only
// ---------------------------------------------------------------------------

function generateRequiredOnly(schema: Readonly<Record<string, unknown>>): unknown {
  const type = getSchemaType(schema);
  if (type !== "object") return generateMinimalValue(schema);

  const props = getProperties(schema);
  if (props === undefined) return {};

  const required = getRequired(schema);
  const result: Record<string, unknown> = {};
  for (const key of required) {
    const propSchema = props[key];
    if (propSchema !== undefined) {
      result[key] = generateMinimalValue(propSchema);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Strategy 3: Null variants (optional fields set to null)
// ---------------------------------------------------------------------------

function generateNullVariants(schema: Readonly<Record<string, unknown>>): readonly TestCase[] {
  const type = getSchemaType(schema);
  if (type !== "object") return [];

  const props = getProperties(schema);
  if (props === undefined) return [];

  const required = getRequired(schema);
  const requiredSet = new Set(required);
  const optionalKeys = Object.keys(props).filter((k) => !requiredSet.has(k));

  const cases: TestCase[] = [];
  for (const key of optionalKeys) {
    // Build a base object with all required fields + this field set to null
    const base: Record<string, unknown> = {};
    for (const rk of required) {
      const propSchema = props[rk];
      if (propSchema !== undefined) {
        base[rk] = generateMinimalValue(propSchema);
      }
    }
    base[key] = null;
    cases.push({ name: `auto:null_${key}`, input: base });
  }
  return cases;
}

// ---------------------------------------------------------------------------
// Strategy 4: Boundary values
// ---------------------------------------------------------------------------

function generateBoundaryValues(schema: Readonly<Record<string, unknown>>): readonly TestCase[] {
  const type = getSchemaType(schema);
  const cases: TestCase[] = [];

  switch (type) {
    case "string": {
      const minLen = typeof schema.minLength === "number" ? schema.minLength : undefined;
      const maxLen = typeof schema.maxLength === "number" ? schema.maxLength : undefined;
      // Empty string
      cases.push({ name: "auto:boundary_empty_string", input: "" });
      if (minLen !== undefined && minLen > 0) {
        cases.push({ name: "auto:boundary_min_length", input: "a".repeat(minLen) });
      }
      if (maxLen !== undefined) {
        cases.push({ name: "auto:boundary_max_length", input: "a".repeat(maxLen) });
      }
      break;
    }
    case "number":
    case "integer": {
      const min = typeof schema.minimum === "number" ? schema.minimum : undefined;
      const max = typeof schema.maximum === "number" ? schema.maximum : undefined;
      const exMin =
        typeof schema.exclusiveMinimum === "number" ? schema.exclusiveMinimum : undefined;
      const exMax =
        typeof schema.exclusiveMaximum === "number" ? schema.exclusiveMaximum : undefined;
      cases.push({ name: "auto:boundary_zero", input: 0 });
      cases.push({ name: "auto:boundary_negative", input: -1 });
      if (min !== undefined) {
        cases.push({ name: "auto:boundary_minimum", input: min });
      }
      if (max !== undefined) {
        cases.push({ name: "auto:boundary_maximum", input: max });
      }
      if (exMin !== undefined) {
        const val = type === "integer" ? Math.ceil(exMin + 1) : exMin + 0.001;
        cases.push({ name: "auto:boundary_above_exclusive_min", input: val });
      }
      if (exMax !== undefined) {
        const val = type === "integer" ? Math.floor(exMax - 1) : exMax - 0.001;
        cases.push({ name: "auto:boundary_below_exclusive_max", input: val });
      }
      break;
    }
    case "boolean":
      cases.push({ name: "auto:boundary_true", input: true });
      cases.push({ name: "auto:boundary_false", input: false });
      break;
    case "array": {
      const minItems = typeof schema.minItems === "number" ? schema.minItems : undefined;
      const maxItems = typeof schema.maxItems === "number" ? schema.maxItems : undefined;
      const items = getItems(schema);
      // Empty array
      cases.push({ name: "auto:boundary_empty_array", input: [] });
      if (minItems !== undefined && minItems > 0) {
        const itemVal = items !== undefined ? generateMinimalValue(items) : null;
        cases.push({
          name: "auto:boundary_min_items",
          input: Array.from({ length: minItems }, () => itemVal),
        });
      }
      if (maxItems !== undefined) {
        const itemVal = items !== undefined ? generateMinimalValue(items) : null;
        cases.push({
          name: "auto:boundary_max_items",
          input: Array.from({ length: maxItems }, () => itemVal),
        });
      }
      break;
    }
    case "object": {
      // Boundary for object: empty object
      cases.push({ name: "auto:boundary_empty_object", input: {} });
      // Per-property boundaries
      const props = getProperties(schema);
      if (props !== undefined) {
        for (const [key, propSchema] of Object.entries(props)) {
          const propBoundaries = generateBoundaryValues(propSchema);
          for (const pb of propBoundaries) {
            const base: Record<string, unknown> = {};
            const required = getRequired(schema);
            for (const rk of required) {
              const rSchema = props[rk];
              if (rSchema !== undefined) {
                base[rk] = generateMinimalValue(rSchema);
              }
            }
            base[key] = pb.input;
            cases.push({ name: `auto:boundary_${key}_${stripPrefix(pb.name)}`, input: base });
          }
        }
      }
      break;
    }
    default:
      break;
  }

  return cases;
}

function stripPrefix(name: string): string {
  return name.startsWith("auto:boundary_") ? name.slice("auto:boundary_".length) : name;
}

// ---------------------------------------------------------------------------
// Strategy 5: Type coercion traps
// ---------------------------------------------------------------------------

function generateCoercionTraps(schema: Readonly<Record<string, unknown>>): readonly TestCase[] {
  const type = getSchemaType(schema);
  const cases: TestCase[] = [];

  switch (type) {
    case "number":
    case "integer":
      // String where number expected
      cases.push({ name: "auto:coercion_string_for_number", input: "1" });
      // Boolean where number expected
      cases.push({ name: "auto:coercion_boolean_for_number", input: true });
      break;
    case "string":
      // Number where string expected
      cases.push({ name: "auto:coercion_number_for_string", input: 123 });
      break;
    case "boolean":
      // Number 0 where boolean expected
      cases.push({ name: "auto:coercion_zero_for_boolean", input: 0 });
      // String "true" where boolean expected
      cases.push({ name: "auto:coercion_string_for_boolean", input: "true" });
      break;
    case "array":
      // Object where array expected
      cases.push({ name: "auto:coercion_object_for_array", input: {} });
      // String where array expected
      cases.push({ name: "auto:coercion_string_for_array", input: "[]" });
      break;
    case "object": {
      // Array where object expected
      cases.push({ name: "auto:coercion_array_for_object", input: [] });
      // Per-property coercion traps
      const props = getProperties(schema);
      if (props !== undefined) {
        for (const [key, propSchema] of Object.entries(props)) {
          const propTraps = generateCoercionTraps(propSchema);
          for (const pt of propTraps) {
            const base: Record<string, unknown> = {};
            const required = getRequired(schema);
            for (const rk of required) {
              const rSchema = props[rk];
              if (rSchema !== undefined) {
                base[rk] = generateMinimalValue(rSchema);
              }
            }
            base[key] = pt.input;
            cases.push({
              name: `auto:coercion_${key}_${stripCoercionPrefix(pt.name)}`,
              input: base,
            });
          }
        }
      }
      break;
    }
    default:
      break;
  }

  return cases;
}

function stripCoercionPrefix(name: string): string {
  return name.startsWith("auto:coercion_") ? name.slice("auto:coercion_".length) : name;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (a === null || b === null) return false;
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if ((a as Record<string, unknown>)[key] !== (b as Record<string, unknown>)[key]) return false;
  }
  return true;
}
