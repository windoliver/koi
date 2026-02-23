/**
 * Stage 1: Static validation — name, schema, size, security checks.
 * No external deps. Pure synchronous validation.
 */

import type { Result } from "@koi/core";
import type { VerificationConfig } from "./config.js";
import type { ForgeError } from "./errors.js";
import { staticError } from "./errors.js";
import type { ForgeInput, StageReport } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{2,49}$/;
const MAX_DESCRIPTION_LENGTH = 500;
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateName(name: string): ForgeError | undefined {
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    return staticError("INVALID_NAME", `Name contains path traversal characters: "${name}"`);
  }
  if (!NAME_PATTERN.test(name)) {
    return staticError("INVALID_NAME", `Name must match ${NAME_PATTERN.source}, got: "${name}"`);
  }
  return undefined;
}

function validateDescription(description: string): ForgeError | undefined {
  if (description.length === 0) {
    return staticError("MISSING_FIELD", "Description must not be empty");
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return staticError(
      "SIZE_EXCEEDED",
      `Description exceeds ${MAX_DESCRIPTION_LENGTH} chars (got ${description.length})`,
    );
  }
  return undefined;
}

function hasDangerousKeys(obj: unknown, depth = 0): boolean {
  if (depth > 10 || obj === null || typeof obj !== "object") {
    return false;
  }
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    if (DANGEROUS_KEYS.has(key)) {
      return true;
    }
    if (hasDangerousKeys((obj as Record<string, unknown>)[key], depth + 1)) {
      return true;
    }
  }
  return false;
}

function validateSchema(schema: Readonly<Record<string, unknown>>): ForgeError | undefined {
  if (schema.type === undefined) {
    return staticError("INVALID_SCHEMA", 'Input schema must have a "type" field');
  }
  if (hasDangerousKeys(schema)) {
    return staticError(
      "INVALID_SCHEMA",
      "Input schema contains dangerous keys (__proto__, constructor, prototype)",
    );
  }
  return undefined;
}

function validateSize(content: string, maxBytes: number, label: string): ForgeError | undefined {
  const size = Buffer.byteLength(content, "utf8");
  if (size > maxBytes) {
    return staticError("SIZE_EXCEEDED", `${label} exceeds ${maxBytes} bytes (got ${size})`);
  }
  return undefined;
}

type BunLoader = "ts" | "tsx" | "js" | "jsx";

const EXTENSION_TO_LOADER: ReadonlyMap<string, BunLoader> = new Map([
  [".ts", "ts"],
  [".tsx", "tsx"],
  [".js", "js"],
  [".jsx", "jsx"],
]);

function extractParseDetail(e: unknown): string {
  if (e instanceof AggregateError && Array.isArray(e.errors) && e.errors.length > 0) {
    return (e.errors as ReadonlyArray<{ readonly message?: unknown }>)
      .map((err) => (typeof err.message === "string" ? err.message : String(err)))
      .join("; ");
  }
  return e instanceof Error ? e.message : String(e);
}

/** Returns the raw parse error detail string, or `undefined` if syntax is valid. */
function extractSyntaxError(code: string, loader: BunLoader): string | undefined {
  try {
    new Bun.Transpiler({ loader }).scan(code);
    return undefined;
  } catch (e: unknown) {
    return extractParseDetail(e);
  }
}

function validateToolInput(
  input: Extract<ForgeInput, { readonly kind: "tool" }>,
  config: VerificationConfig,
): ForgeError | undefined {
  if (input.implementation.length === 0) {
    return staticError("MISSING_FIELD", "Tool implementation must not be empty");
  }
  const schemaErr = validateSchema(input.inputSchema);
  if (schemaErr !== undefined) {
    return schemaErr;
  }
  const sizeErr = validateSize(input.implementation, config.maxBrickSizeBytes, "Implementation");
  if (sizeErr !== undefined) {
    return sizeErr;
  }
  const syntaxDetail = extractSyntaxError(input.implementation, "ts");
  if (syntaxDetail !== undefined) {
    return staticError("SYNTAX_ERROR", `Syntax error in implementation: ${syntaxDetail}`);
  }
  return undefined;
}

function validateSkillInput(
  input: Extract<ForgeInput, { readonly kind: "skill" }>,
  config: VerificationConfig,
): ForgeError | undefined {
  if (input.content.length === 0) {
    return staticError("MISSING_FIELD", "Skill content must not be empty");
  }
  return validateSize(input.content, config.maxBrickSizeBytes, "Content");
}

function validateAgentInput(
  input: Extract<ForgeInput, { readonly kind: "agent" }>,
  config: VerificationConfig,
): ForgeError | undefined {
  if (input.manifestYaml.length === 0) {
    return staticError("MISSING_FIELD", "Agent manifest YAML must not be empty");
  }
  return validateSize(input.manifestYaml, config.maxBrickSizeBytes, "Manifest YAML");
}

function validateCompositeInput(
  input: Extract<ForgeInput, { readonly kind: "composite" }>,
): ForgeError | undefined {
  if (input.brickIds.length === 0) {
    return staticError("MISSING_FIELD", "Composite must reference at least one brick");
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Universal validators (files + requires — apply to all brick kinds)
// ---------------------------------------------------------------------------

const MAX_FILES_TOTAL_BYTES = 500_000;

function validateFiles(files: Readonly<Record<string, string>>): ForgeError | undefined {
  const keys = Object.keys(files);
  if (keys.length === 0) {
    return staticError("MISSING_FIELD", "files must contain at least one entry if provided");
  }

  let totalBytes = 0;
  for (const key of keys) {
    // Reject absolute paths
    if (key.startsWith("/") || key.startsWith("\\")) {
      return staticError("INVALID_NAME", `File path must be relative, got: "${key}"`);
    }
    // Reject path traversal
    if (key.includes("..")) {
      return staticError("INVALID_NAME", `File path contains '..': "${key}"`);
    }
    // Reject dangerous keys
    if (DANGEROUS_KEYS.has(key)) {
      return staticError("INVALID_NAME", `File path uses dangerous key: "${key}"`);
    }

    const value = files[key];
    if (typeof value !== "string") {
      return staticError("INVALID_SCHEMA", `File content for "${key}" must be a string`);
    }
    totalBytes += Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8");
    if (totalBytes > MAX_FILES_TOTAL_BYTES) {
      return staticError(
        "SIZE_EXCEEDED",
        `Total files size exceeds ${MAX_FILES_TOTAL_BYTES} bytes (got ${totalBytes})`,
      );
    }

    // Syntax-check TS/JS files
    const extIndex = key.lastIndexOf(".");
    const loader = extIndex !== -1 ? EXTENSION_TO_LOADER.get(key.slice(extIndex)) : undefined;
    if (loader !== undefined) {
      const syntaxDetail = extractSyntaxError(value, loader);
      if (syntaxDetail !== undefined) {
        return staticError("SYNTAX_ERROR", `Syntax error in file "${key}": ${syntaxDetail}`);
      }
    }
  }
  return undefined;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validateRequires(requires: unknown): ForgeError | undefined {
  if (typeof requires !== "object" || requires === null) {
    return staticError("INVALID_SCHEMA", "requires must be an object");
  }
  const rec = requires as Record<string, unknown>;

  if (rec.bins !== undefined && !isStringArray(rec.bins)) {
    return staticError("INVALID_SCHEMA", "requires.bins must be an array of strings");
  }
  if (rec.env !== undefined && !isStringArray(rec.env)) {
    return staticError("INVALID_SCHEMA", "requires.env must be an array of strings");
  }
  if (rec.tools !== undefined && !isStringArray(rec.tools)) {
    return staticError("INVALID_SCHEMA", "requires.tools must be an array of strings");
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function verifyStatic(
  input: ForgeInput,
  config: VerificationConfig,
): Result<StageReport, ForgeError> {
  const start = performance.now();

  const nameErr = validateName(input.name);
  if (nameErr !== undefined) {
    return { ok: false, error: nameErr };
  }

  const descErr = validateDescription(input.description);
  if (descErr !== undefined) {
    return { ok: false, error: descErr };
  }

  let kindErr: ForgeError | undefined;
  switch (input.kind) {
    case "tool":
      kindErr = validateToolInput(input, config);
      break;
    case "skill":
      kindErr = validateSkillInput(input, config);
      break;
    case "agent":
      kindErr = validateAgentInput(input, config);
      break;
    case "composite":
      kindErr = validateCompositeInput(input);
      break;
  }

  if (kindErr !== undefined) {
    return { ok: false, error: kindErr };
  }

  // Universal: validate files if present
  if (input.files !== undefined) {
    const filesErr = validateFiles(input.files);
    if (filesErr !== undefined) {
      return { ok: false, error: filesErr };
    }
  }

  // Universal: validate requires if present
  if (input.requires !== undefined) {
    const requiresErr = validateRequires(input.requires);
    if (requiresErr !== undefined) {
      return { ok: false, error: requiresErr };
    }
  }

  const durationMs = performance.now() - start;
  return {
    ok: true,
    value: { stage: "static", passed: true, durationMs },
  };
}
