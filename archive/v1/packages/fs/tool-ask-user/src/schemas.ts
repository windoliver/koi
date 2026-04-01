/**
 * Zod schemas for validating ask-user tool input and response.
 */

import type { KoiError, Result } from "@koi/core";
import type { ElicitationQuestion, ElicitationResult } from "@koi/core/elicitation";
import { validateWith } from "@koi/validation";
import { z } from "zod";

/** Schema for a single elicitation option. */
const ElicitationOptionSchema = z.object({
  label: z.string().min(1, "Option label must not be empty"),
  description: z.string().min(1, "Option description must not be empty"),
});

/** Schema for the tool's input arguments (model → tool). */
const ElicitationQuestionSchema = z.object({
  question: z.string().min(1, "Question must not be empty"),
  header: z.string().max(12, "Header must be 12 characters or fewer").optional(),
  options: z.array(ElicitationOptionSchema).min(2, "At least 2 options are required"),
  multiSelect: z.boolean().optional(),
});

/** Schema for the handler's response (handler → tool). */
const ElicitationResultSchema = z.object({
  selected: z.array(z.string()),
  freeText: z.string().optional(),
});

/**
 * Creates a refined schema with a maxOptions constraint.
 * Call once and reuse — avoids re-allocating the schema on every validation.
 */
export function createQuestionSchema(maxOptions: number): z.ZodType<ElicitationQuestion> {
  return ElicitationQuestionSchema.refine((q) => q.options.length <= maxOptions, {
    message: `Too many options (max ${String(maxOptions)})`,
  });
}

/**
 * Validates raw model args into an `ElicitationQuestion`.
 *
 * @param raw - Unknown input from the model.
 * @param schema - Pre-built refined schema (from `createQuestionSchema`).
 */
export function validateQuestionInput(
  raw: unknown,
  schema: z.ZodType<ElicitationQuestion>,
): Result<ElicitationQuestion, KoiError> {
  return validateWith(schema, raw, "ask_user input validation failed");
}

/**
 * Validates the handler's response against the original question.
 *
 * Rules:
 * - If multiSelect is false and selected.length > 1 → VALIDATION error
 * - If selected contains labels not in options (and no freeText) → VALIDATION error
 * - If selected is empty and freeText is undefined/empty → VALIDATION error
 * - Free-text is always accepted as an escape hatch
 */
export function validateHandlerResponse(
  raw: unknown,
  question: ElicitationQuestion,
): Result<ElicitationResult, KoiError> {
  const parseResult = validateWith(
    ElicitationResultSchema,
    raw,
    "ask_user response validation failed",
  );
  if (!parseResult.ok) {
    return parseResult;
  }

  const response = parseResult.value;
  const hasFreeText = response.freeText !== undefined && response.freeText.length > 0;

  // Must have at least one answer (selection or free-text)
  if (response.selected.length === 0 && !hasFreeText) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message:
          "ask_user response validation failed: no answer provided (select an option or provide free text)",
        retryable: false,
      },
    };
  }

  // Single-select enforcement
  if (question.multiSelect !== true && response.selected.length > 1) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message:
          "ask_user response validation failed: multiple selections not allowed (multiSelect is false)",
        retryable: false,
      },
    };
  }

  // Validate selected labels exist in options (unless free-text is the escape hatch)
  if (response.selected.length > 0) {
    const validLabels = new Set(question.options.map((o) => o.label));
    const invalid = response.selected.filter((s) => !validLabels.has(s));
    if (invalid.length > 0 && !hasFreeText) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `ask_user response validation failed: unknown option(s): ${invalid.join(", ")}`,
          retryable: false,
          context: { invalidLabels: invalid },
        },
      };
    }
  }

  return { ok: true, value: response };
}
