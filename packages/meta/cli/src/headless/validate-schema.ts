type SchemaValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly path: string; readonly message: string };

// Value types supported by this schema subset.
// "integer" = whole numbers only (Number.isInteger); fractional numbers fail.
const VALUE_TYPES = new Set<string>([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

const SUPPORTED_KEYWORDS = new Set<string>(["type", "required", "properties", "items", "enum"]);

const ANNOTATION_KEYWORDS = new Set<string>(["$schema", "title", "description", "$comment"]);

// A schema object after shape-checking (all values still unknown).
type RawSchema = {
  readonly type?: unknown;
  readonly enum?: unknown;
  readonly required?: unknown;
  readonly properties?: unknown;
  readonly items?: unknown;
  readonly $schema?: unknown;
  readonly title?: unknown;
  readonly description?: unknown;
  readonly $comment?: unknown;
};

type BootResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

function toRawSchema(obj: Record<string, unknown>): RawSchema {
  return obj as RawSchema;
}

function findUnsupportedKeyword(s: RawSchema): string | undefined {
  for (const key of Object.keys(s)) {
    if (!SUPPORTED_KEYWORDS.has(key) && !ANNOTATION_KEYWORDS.has(key)) return key;
  }
  return undefined;
}

function checkStructureType(s: RawSchema, path: string): BootResult {
  if (s.type === undefined) return { ok: true };
  if (typeof s.type !== "string" || !VALUE_TYPES.has(s.type)) {
    return {
      ok: false,
      message: `schema.type at ${path || "root"} must be one of: ${[...VALUE_TYPES].join(", ")}`,
    };
  }
  return { ok: true };
}

function checkStructureEnum(s: RawSchema, path: string): BootResult {
  if (s.enum === undefined) return { ok: true };
  if (!Array.isArray(s.enum)) {
    return { ok: false, message: `schema.enum at ${path || "root"} must be an array` };
  }
  for (const entry of s.enum as unknown[]) {
    if (entry !== null && typeof entry === "object") {
      return {
        ok: false,
        message: `schema.enum at ${path || "root"} must contain only scalar values (string, number, boolean, null); objects and arrays are not supported`,
      };
    }
  }
  return { ok: true };
}

function checkStructureRequired(s: RawSchema, path: string): BootResult {
  if (s.required === undefined) return { ok: true };
  if (
    !Array.isArray(s.required) ||
    !(s.required as unknown[]).every((k) => typeof k === "string")
  ) {
    return {
      ok: false,
      message: `schema.required at ${path || "root"} must be an array of strings`,
    };
  }
  return { ok: true };
}

function checkStructureProperties(s: RawSchema, path: string): BootResult {
  if (s.properties === undefined) return { ok: true };
  if (typeof s.properties !== "object" || s.properties === null || Array.isArray(s.properties)) {
    return { ok: false, message: `schema.properties at ${path || "root"} must be an object` };
  }
  for (const [key, value] of Object.entries(s.properties as Record<string, unknown>)) {
    const subPath = path ? `${path}.properties.${key}` : `properties.${key}`;
    const result = validateSchemaStructure(value, subPath);
    if (!result.ok) return result;
  }
  return { ok: true };
}

function checkStructureItems(s: RawSchema, path: string): BootResult {
  if (s.items === undefined) return { ok: true };
  const itemsPath = path ? `${path}.items` : "items";
  return validateSchemaStructure(s.items, itemsPath);
}

function validateSchemaStructure(s: unknown, path: string): BootResult {
  if (typeof s !== "object" || s === null || Array.isArray(s)) {
    return { ok: false, message: `schema at ${path || "root"} must be a JSON object` };
  }
  const obj = toRawSchema(s as Record<string, unknown>);
  const unsupported = findUnsupportedKeyword(obj);
  if (unsupported !== undefined) {
    return {
      ok: false,
      message: `unsupported schema keyword at ${path || "root"}: ${unsupported}`,
    };
  }
  const checks: ReadonlyArray<BootResult> = [
    checkStructureType(obj, path),
    checkStructureEnum(obj, path),
    checkStructureRequired(obj, path),
    checkStructureProperties(obj, path),
    checkStructureItems(obj, path),
  ];
  for (const check of checks) {
    if (!check.ok) return check;
  }
  return { ok: true };
}

export function validateLoadedSchema(
  raw: unknown,
):
  | { readonly ok: true; readonly schema: Record<string, unknown> }
  | { readonly ok: false; readonly message: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, message: "schema must be a JSON object at the root" };
  }
  const structure = validateSchemaStructure(raw, "");
  if (!structure.ok) return { ok: false, message: structure.message };
  return { ok: true, schema: raw as Record<string, unknown> };
}

function checkRuntimeType(value: unknown, s: RawSchema, path: string): SchemaValidationResult {
  if (s.type === undefined) return { ok: true };
  if (typeof s.type !== "string" || !VALUE_TYPES.has(s.type)) {
    return {
      ok: false,
      path: path || "",
      message: `invalid schema: type must be one of: ${[...VALUE_TYPES].join(", ")}`,
    };
  }
  if (s.type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      return {
        ok: false,
        path: path || "",
        message: `expected integer, got ${typeof value === "number" ? "fractional number" : valueType(value)}`,
      };
    }
    return { ok: true };
  }
  if (valueType(value) !== s.type) {
    return {
      ok: false,
      path: path || "",
      message: `expected type ${s.type}, got ${valueType(value)}`,
    };
  }
  return { ok: true };
}

function checkRuntimeEnum(value: unknown, s: RawSchema, path: string): SchemaValidationResult {
  if (s.enum === undefined) return { ok: true };
  if (!Array.isArray(s.enum)) {
    return { ok: false, path: path || "", message: "invalid schema: enum must be an array" };
  }
  if (!s.enum.includes(value)) {
    return {
      ok: false,
      path: path || "",
      message: `must be one of: ${(s.enum as unknown[]).map(String).join(", ")}`,
    };
  }
  return { ok: true };
}

function checkRuntimeRequired(value: unknown, s: RawSchema, path: string): SchemaValidationResult {
  if (s.required === undefined) return { ok: true };
  if (
    !Array.isArray(s.required) ||
    !(s.required as unknown[]).every((k) => typeof k === "string")
  ) {
    return {
      ok: false,
      path: path || "",
      message: "invalid schema: required must be an array of strings",
    };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    const firstKey = (s.required as string[])[0] ?? "field";
    const fieldPath = path ? `${path}.${firstKey}` : firstKey;
    return { ok: false, path: fieldPath, message: `${firstKey} is required` };
  }
  const obj = value as Record<string, unknown>;
  for (const key of s.required as string[]) {
    if (!Object.hasOwn(obj, key)) {
      const fieldPath = path ? `${path}.${key}` : key;
      return { ok: false, path: fieldPath, message: `${key} is required` };
    }
  }
  return { ok: true };
}

function checkRuntimeProperties(
  value: unknown,
  s: RawSchema,
  path: string,
): SchemaValidationResult {
  if (s.properties === undefined) return { ok: true };
  if (typeof s.properties !== "object" || s.properties === null || Array.isArray(s.properties)) {
    return { ok: false, path: path || "", message: "invalid schema: properties must be an object" };
  }
  // Fail closed: `properties` implies the value must be an object. Without
  // this guard, a schema like `{ properties: { id: { type: "number" } } }`
  // would silently pass for a string value because the property-walk loop
  // never runs. A `type: "object"` sibling would catch it, but authors
  // commonly omit the redundant type on nested sub-schemas.
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      path: path || "",
      message: `expected object (properties keyword requires an object value), got ${valueType(value)}`,
    };
  }
  const obj = value as Record<string, unknown>;
  for (const [key, subSchema] of Object.entries(s.properties as Record<string, unknown>)) {
    if (Object.hasOwn(obj, key)) {
      const subPath = path ? `${path}.${key}` : key;
      const result = validateSchema(obj[key], subSchema, subPath);
      if (!result.ok) return result;
    }
  }
  return { ok: true };
}

function checkRuntimeItems(value: unknown, s: RawSchema, path: string): SchemaValidationResult {
  if (s.items === undefined) return { ok: true };
  // Fail closed: `items` implies the value must be an array. Same reasoning
  // as checkRuntimeProperties — omitting `type: "array"` on a nested schema
  // must not silently skip element validation.
  if (!Array.isArray(value)) {
    return {
      ok: false,
      path: path || "",
      message: `expected array (items keyword requires an array value), got ${valueType(value)}`,
    };
  }
  for (let i = 0; i < value.length; i++) {
    const subPath = path ? `${path}[${i}]` : `[${i}]`;
    const result = validateSchema(value[i], s.items, subPath);
    if (!result.ok) return result;
  }
  return { ok: true };
}

export function validateSchema(value: unknown, schema: unknown, path = ""): SchemaValidationResult {
  if (typeof schema !== "object" || schema === null) {
    return { ok: false, path, message: "schema must be an object" };
  }
  const raw = schema as Record<string, unknown>;
  const unsupported = findUnsupportedKeyword(toRawSchema(raw));
  if (unsupported !== undefined) {
    return { ok: false, path: path || "", message: `unsupported schema keyword: ${unsupported}` };
  }
  const s = toRawSchema(raw);
  const checks: ReadonlyArray<SchemaValidationResult> = [
    checkRuntimeType(value, s, path),
    checkRuntimeEnum(value, s, path),
    checkRuntimeRequired(value, s, path),
    checkRuntimeProperties(value, s, path),
    checkRuntimeItems(value, s, path),
  ];
  for (const check of checks) {
    if (!check.ok) return check;
  }
  return { ok: true };
}

export function validateResultSchema(
  assembled: string,
  schema: Record<string, unknown>,
): { readonly ok: true } | { readonly ok: false; readonly error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(assembled);
  } catch (_e: unknown) {
    return { ok: false, error: "schema validation failed: assistant output is not valid JSON" };
  }
  const result = validateSchema(parsed, schema);
  if (!result.ok) {
    const loc = result.path ? `${result.path} ` : "";
    return {
      ok: false,
      error: `schema validation failed: ${loc}${result.message}`,
    };
  }
  return { ok: true };
}

function valueType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}
