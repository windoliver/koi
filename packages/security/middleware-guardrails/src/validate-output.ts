/**
 * Output validation — parse content and apply Zod schemas.
 *
 * Pure functions with no side effects. Handles both JSON and text parse modes.
 */

import type { GuardrailError, GuardrailParseMode, GuardrailRule } from "./types.js";

/** Result of validating output against guardrail rules. */
export interface GuardrailValidationResult {
  readonly valid: boolean;
  readonly errors: readonly GuardrailError[];
  /** The first failing rule name, if any. */
  readonly failedRule?: string | undefined;
}

const EMPTY_RESULT: GuardrailValidationResult = { valid: true, errors: [] } as const;

/**
 * Validates model output content against guardrail rules.
 *
 * JSON mode: parses content as JSON, then applies schema.safeParse.
 * Text mode: wraps content as `{ text: content }` before schema.safeParse.
 */
export function validateModelOutput(
  content: string,
  rules: readonly GuardrailRule[],
  parseMode: GuardrailParseMode = "json",
): GuardrailValidationResult {
  if (rules.length === 0) return EMPTY_RESULT;

  // Parse content based on mode
  // let justified: parsed may be JSON object or text wrapper
  let parsed: unknown;
  if (parseMode === "json") {
    try {
      parsed = JSON.parse(content);
    } catch {
      return {
        valid: false,
        errors: [
          {
            path: "",
            message: `Failed to parse model output as JSON: ${content.slice(0, 100)}`,
            code: "invalid_json",
          },
        ],
        failedRule: rules[0]?.name,
      };
    }
  } else {
    parsed = { text: content };
  }

  return applySchemas(parsed, rules);
}

/**
 * Validates tool output against guardrail rules.
 *
 * No JSON parsing needed — tool output is already structured data.
 */
export function validateToolOutput(
  output: unknown,
  rules: readonly GuardrailRule[],
): GuardrailValidationResult {
  if (rules.length === 0) return EMPTY_RESULT;
  return applySchemas(output, rules);
}

/**
 * Applies each rule's Zod schema to the parsed value.
 * Returns on first failure (fail-fast).
 */
function applySchemas(value: unknown, rules: readonly GuardrailRule[]): GuardrailValidationResult {
  for (const rule of rules) {
    const result = rule.schema.safeParse(value);
    if (!result.success) {
      const errors: readonly GuardrailError[] = result.error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
        code: issue.code,
      }));
      return { valid: false, errors, failedRule: rule.name };
    }
  }
  return EMPTY_RESULT;
}
