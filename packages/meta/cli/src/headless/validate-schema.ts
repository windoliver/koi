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

function toRawSchema(obj: Record<string, unknown>): RawSchema {
  return obj as RawSchema;
}

function validateSchemaStructure(
  s: unknown,
  path: string,
): { readonly ok: true } | { readonly ok: false; readonly message: string } {
  if (typeof s !== "object" || s === null || Array.isArray(s)) {
    return { ok: false, message: `schema at ${path || "root"} must be a JSON object` };
  }
  const raw = s as Record<string, unknown>;

  for (const key of Object.keys(raw)) {
    if (!SUPPORTED_KEYWORDS.has(key) && !ANNOTATION_KEYWORDS.has(key)) {
      return {
        ok: false,
        message: `unsupported schema keyword at ${path || "root"}: ${key}`,
      };
    }
  }

  const obj = toRawSchema(raw);

  if (obj.type !== undefined) {
    if (typeof obj.type !== "string" || !VALUE_TYPES.has(obj.type)) {
      return {
        ok: false,
        message: `schema.type at ${path || "root"} must be one of: ${[...VALUE_TYPES].join(", ")}`,
      };
    }
  }

  if (obj.enum !== undefined) {
    if (!Array.isArray(obj.enum)) {
      return { ok: false, message: `schema.enum at ${path || "root"} must be an array` };
    }
    for (const entry of obj.enum as unknown[]) {
      if (entry !== null && typeof entry === "object") {
        return {
          ok: false,
          message: `schema.enum at ${path || "root"} must contain only scalar values (string, number, boolean, null); objects and arrays are not supported`,
        };
      }
    }
  }

  if (obj.required !== undefined) {
    if (
      !Array.isArray(obj.required) ||
      !(obj.required as unknown[]).every((k) => typeof k === "string")
    ) {
      return {
        ok: false,
        message: `schema.required at ${path || "root"} must be an array of strings`,
      };
    }
  }

  if (obj.properties !== undefined) {
    if (
      typeof obj.properties !== "object" ||
      obj.properties === null ||
      Array.isArray(obj.properties)
    ) {
      return {
        ok: false,
        message: `schema.properties at ${path || "root"} must be an object`,
      };
    }
    for (const [key, value] of Object.entries(obj.properties as Record<string, unknown>)) {
      const subPath = path ? `${path}.properties.${key}` : `properties.${key}`;
      const result = validateSchemaStructure(value, subPath);
      if (!result.ok) return result;
    }
  }

  if (obj.items !== undefined) {
    const itemsPath = path ? `${path}.items` : "items";
    const result = validateSchemaStructure(obj.items, itemsPath);
    if (!result.ok) return result;
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

export function validateSchema(value: unknown, schema: unknown, path = ""): SchemaValidationResult {
  if (typeof schema !== "object" || schema === null) {
    return { ok: false, path, message: "schema must be an object" };
  }
  const raw = schema as Record<string, unknown>;

  for (const key of Object.keys(raw)) {
    if (!SUPPORTED_KEYWORDS.has(key) && !ANNOTATION_KEYWORDS.has(key)) {
      return { ok: false, path: path || ".", message: `unsupported schema keyword: ${key}` };
    }
  }

  const s = toRawSchema(raw);

  if (s.type !== undefined) {
    if (typeof s.type !== "string" || !VALUE_TYPES.has(s.type)) {
      return {
        ok: false,
        path: path || ".",
        message: `invalid schema: type must be one of: ${[...VALUE_TYPES].join(", ")}`,
      };
    }
    if (s.type === "integer") {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return {
          ok: false,
          path: path || ".",
          message: `expected integer, got ${typeof value === "number" ? "fractional number" : valueType(value)}`,
        };
      }
    } else if (valueType(value) !== s.type) {
      return {
        ok: false,
        path: path || ".",
        message: `expected type ${s.type}, got ${valueType(value)}`,
      };
    }
  }

  if (s.enum !== undefined) {
    if (!Array.isArray(s.enum)) {
      return { ok: false, path: path || ".", message: "invalid schema: enum must be an array" };
    }
    if (!s.enum.includes(value)) {
      return {
        ok: false,
        path: path || ".",
        message: `must be one of: ${(s.enum as unknown[]).map(String).join(", ")}`,
      };
    }
  }

  if (s.required !== undefined) {
    if (
      !Array.isArray(s.required) ||
      !(s.required as unknown[]).every((k) => typeof k === "string")
    ) {
      return {
        ok: false,
        path: path || ".",
        message: "invalid schema: required must be an array of strings",
      };
    }
    const obj = value as Record<string, unknown>;
    for (const key of s.required as string[]) {
      if (typeof obj !== "object" || obj === null || !(key in obj)) {
        const fieldPath = path ? `${path}.${key}` : key;
        return { ok: false, path: fieldPath, message: `${key} is required` };
      }
    }
  }

  if (s.properties !== undefined) {
    if (typeof s.properties !== "object" || s.properties === null || Array.isArray(s.properties)) {
      return {
        ok: false,
        path: path || ".",
        message: "invalid schema: properties must be an object",
      };
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      for (const [key, subSchema] of Object.entries(s.properties as Record<string, unknown>)) {
        if (key in obj) {
          const subPath = path ? `${path}.${key}` : key;
          const result = validateSchema(obj[key], subSchema, subPath);
          if (!result.ok) return result;
        }
      }
    }
  }

  if (s.items !== undefined) {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const subPath = path ? `${path}[${i}]` : `[${i}]`;
        const result = validateSchema(value[i], s.items, subPath);
        if (!result.ok) return result;
      }
    }
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
  } catch {
    return { ok: false, error: "schema validation failed: assistant output is not valid JSON" };
  }
  const result = validateSchema(parsed, schema);
  if (!result.ok) {
    return {
      ok: false,
      error: `schema validation failed: ${result.path} ${result.message}`,
    };
  }
  return { ok: true };
}

function valueType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}
