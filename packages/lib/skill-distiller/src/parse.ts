import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import type { SkillDraft, SkillDraftParameter } from "./types.js";

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

function fail(message: string, errorKind: string): Result<SkillDraft, KoiError> {
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
    out.push({
      name: obj.name,
      description: obj.description,
      required: obj.required,
    });
  }
  return { ok: true, value: out };
}

export function parseSkillDraft(jsonText: string): Result<SkillDraft, KoiError> {
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
  if (!isStringArray(obj.triggers)) {
    return fail("triggers must be string[]", "DRAFT_TRIGGERS_INVALID");
  }
  if (!isStringArray(obj.toolSequence)) {
    return fail("toolSequence must be string[]", "DRAFT_TOOL_SEQUENCE_INVALID");
  }
  if (!isStringArray(obj.expectedInputs)) {
    return fail("expectedInputs must be string[]", "DRAFT_EXPECTED_INPUTS_INVALID");
  }
  if (!isStringArray(obj.expectedOutputs)) {
    return fail("expectedOutputs must be string[]", "DRAFT_EXPECTED_OUTPUTS_INVALID");
  }
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
