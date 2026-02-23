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
  return validateSize(input.implementation, config.maxBrickSizeBytes, "Implementation");
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

  const durationMs = performance.now() - start;
  return {
    ok: true,
    value: { stage: "static", passed: true, durationMs },
  };
}
