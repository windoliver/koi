import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import type { SkillDraft, SkillDraftParameter } from "./types.js";

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
// Per-field caps matched to the prompt contract. Anything well outside these
// is either an adversarial/buggy LLM response or not a useful skill — reject
// before it reaches hashing, audit, staging, or store.
const MAX_DESCRIPTION = 200;
const MAX_TRIGGER_COUNT = 32;
const MAX_TRIGGER_LENGTH = 200;
const MAX_PARAMETER_COUNT = 32;
const MAX_PARAMETER_NAME = 64;
const MAX_PARAMETER_DESCRIPTION = 400;
const MAX_TOOL_SEQUENCE = 64;
const MAX_TOOL_NAME = 128;
const MAX_IO_COUNT = 32;
const MAX_IO_LENGTH = 400;
const MAX_DRAFT_BYTES = 16 * 1024;

function fail<T>(message: string, errorKind: string): Result<T, KoiError> {
  const error: KoiError = {
    code: "VALIDATION",
    message,
    retryable: RETRYABLE_DEFAULTS.VALIDATION,
    context: { errorKind },
  };
  return { ok: false, error };
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function parseParameters(raw: unknown): Result<readonly SkillDraftParameter[], KoiError> {
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "parameters must be an array",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
        context: { errorKind: "DRAFT_PARAMETERS_NOT_ARRAY" },
      },
    };
  }
  if (raw.length > MAX_PARAMETER_COUNT) {
    return fail(
      `parameters has ${raw.length} entries (max ${MAX_PARAMETER_COUNT})`,
      "DRAFT_PARAMETERS_TOO_MANY",
    );
  }
  const out: SkillDraftParameter[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "parameter entry must be an object",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
          context: { errorKind: "DRAFT_PARAMETER_NOT_OBJECT" },
        },
      };
    }
    const obj = entry as Record<string, unknown>;
    if (
      typeof obj.name !== "string" ||
      typeof obj.description !== "string" ||
      typeof obj.required !== "boolean"
    ) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "parameter requires name, description, required",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
          context: { errorKind: "DRAFT_PARAMETER_SHAPE" },
        },
      };
    }
    if (obj.name.length > MAX_PARAMETER_NAME) {
      return fail(
        `parameter name exceeds ${MAX_PARAMETER_NAME} chars`,
        "DRAFT_PARAMETER_NAME_TOO_LONG",
      );
    }
    if (obj.description.length > MAX_PARAMETER_DESCRIPTION) {
      return fail(
        `parameter description exceeds ${MAX_PARAMETER_DESCRIPTION} chars`,
        "DRAFT_PARAMETER_DESCRIPTION_TOO_LONG",
      );
    }
    out.push({
      name: obj.name,
      description: obj.description,
      required: obj.required,
    });
  }
  return { ok: true, value: out };
}

function checkStringArrayBounds(
  arr: readonly string[],
  field: string,
  maxCount: number,
  maxLength: number,
  countKind: string,
  lengthKind: string,
): KoiError | undefined {
  if (arr.length > maxCount) {
    return {
      code: "VALIDATION",
      message: `${field} has ${arr.length} entries (max ${maxCount})`,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
      context: { errorKind: countKind },
    };
  }
  for (const s of arr) {
    if (s.length > maxLength) {
      return {
        code: "VALIDATION",
        message: `${field} entry exceeds ${maxLength} chars`,
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
        context: { errorKind: lengthKind },
      };
    }
  }
  return undefined;
}

export function parseSkillDraft(jsonText: string): Result<SkillDraft, KoiError> {
  if (jsonText.length > MAX_DRAFT_BYTES) {
    return fail(
      `LLM output exceeds ${MAX_DRAFT_BYTES} bytes (got ${jsonText.length})`,
      "DRAFT_TOO_LARGE",
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    return fail("LLM output is not valid JSON", "DRAFT_JSON_PARSE");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return fail("LLM output is not a JSON object", "DRAFT_NOT_OBJECT");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== "string" || !NAME_PATTERN.test(obj.name)) {
    return fail("name must be kebab-case, 1-40 chars", "DRAFT_NAME_INVALID");
  }
  if (typeof obj.description !== "string" || obj.description.length === 0) {
    return fail("description must be a non-empty string", "DRAFT_DESCRIPTION_INVALID");
  }
  if (obj.description.length > MAX_DESCRIPTION) {
    return fail(`description exceeds ${MAX_DESCRIPTION} chars`, "DRAFT_DESCRIPTION_TOO_LONG");
  }
  if (!isStringArray(obj.triggers)) {
    return fail("triggers must be string[]", "DRAFT_TRIGGERS_INVALID");
  }
  const triggersBounds = checkStringArrayBounds(
    obj.triggers,
    "triggers",
    MAX_TRIGGER_COUNT,
    MAX_TRIGGER_LENGTH,
    "DRAFT_TRIGGERS_TOO_MANY",
    "DRAFT_TRIGGER_TOO_LONG",
  );
  if (triggersBounds !== undefined) return { ok: false, error: triggersBounds };
  if (!isStringArray(obj.toolSequence)) {
    return fail("toolSequence must be string[]", "DRAFT_TOOL_SEQUENCE_INVALID");
  }
  const toolBounds = checkStringArrayBounds(
    obj.toolSequence,
    "toolSequence",
    MAX_TOOL_SEQUENCE,
    MAX_TOOL_NAME,
    "DRAFT_TOOL_SEQUENCE_TOO_LONG",
    "DRAFT_TOOL_NAME_TOO_LONG",
  );
  if (toolBounds !== undefined) return { ok: false, error: toolBounds };
  if (!isStringArray(obj.expectedInputs)) {
    return fail("expectedInputs must be string[]", "DRAFT_EXPECTED_INPUTS_INVALID");
  }
  const inputsBounds = checkStringArrayBounds(
    obj.expectedInputs,
    "expectedInputs",
    MAX_IO_COUNT,
    MAX_IO_LENGTH,
    "DRAFT_EXPECTED_INPUTS_TOO_MANY",
    "DRAFT_EXPECTED_INPUT_TOO_LONG",
  );
  if (inputsBounds !== undefined) return { ok: false, error: inputsBounds };
  if (!isStringArray(obj.expectedOutputs)) {
    return fail("expectedOutputs must be string[]", "DRAFT_EXPECTED_OUTPUTS_INVALID");
  }
  const outputsBounds = checkStringArrayBounds(
    obj.expectedOutputs,
    "expectedOutputs",
    MAX_IO_COUNT,
    MAX_IO_LENGTH,
    "DRAFT_EXPECTED_OUTPUTS_TOO_MANY",
    "DRAFT_EXPECTED_OUTPUT_TOO_LONG",
  );
  if (outputsBounds !== undefined) return { ok: false, error: outputsBounds };
  const params = parseParameters(obj.parameters);
  if (!params.ok) return params;
  const draft: SkillDraft = {
    name: obj.name,
    description: obj.description,
    triggers: obj.triggers,
    parameters: params.value,
    toolSequence: obj.toolSequence,
    expectedInputs: obj.expectedInputs,
    expectedOutputs: obj.expectedOutputs,
  };
  return { ok: true, value: draft };
}
