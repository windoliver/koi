/**
 * Built-in deterministic checks for common output quality assertions.
 *
 * Use these as-is or as starting points for custom checks.
 */

import type { DeterministicCheck, VerifierAction } from "./types.js";

/** Default action for built-in checks. */
const DEFAULT_ACTION = "block" satisfies VerifierAction;

/**
 * Fails if the output is empty or contains only whitespace.
 */
export function nonEmpty(action: VerifierAction = DEFAULT_ACTION): DeterministicCheck {
  return {
    name: "non-empty",
    check: (content) => content.trim().length > 0 || "Output must not be empty",
    action,
  };
}

/**
 * Fails if the output exceeds `max` characters.
 */
export function maxLength(
  max: number,
  action: VerifierAction = DEFAULT_ACTION,
): DeterministicCheck {
  return {
    name: `max-length-${max}`,
    check: (content) =>
      content.length <= max || `Output exceeds maximum length of ${max} characters`,
    action,
  };
}

/**
 * Fails if the output does not contain valid JSON.
 */
export function validJson(action: VerifierAction = DEFAULT_ACTION): DeterministicCheck {
  return {
    name: "valid-json",
    check: (content) => {
      try {
        JSON.parse(content);
        return true;
      } catch (_e: unknown) {
        return "Output must be valid JSON";
      }
    },
    action,
  };
}

/**
 * Fails if the output does not match the given regular expression.
 */
export function matchesPattern(
  pattern: RegExp,
  name: string,
  action: VerifierAction = DEFAULT_ACTION,
): DeterministicCheck {
  return {
    name,
    check: (content) =>
      pattern.test(content) || `Output does not match required pattern: ${pattern.source}`,
    action,
  };
}

/** Convenience namespace for built-in checks. */
export const BUILTIN_CHECKS: {
  readonly nonEmpty: typeof nonEmpty;
  readonly maxLength: typeof maxLength;
  readonly validJson: typeof validJson;
  readonly matchesPattern: typeof matchesPattern;
} = {
  nonEmpty,
  maxLength,
  validJson,
  matchesPattern,
};
