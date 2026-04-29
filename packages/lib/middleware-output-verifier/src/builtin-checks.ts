/**
 * Built-in deterministic checks for common output quality assertions.
 */

import type { DeterministicCheck, VerifierAction } from "./types.js";

const DEFAULT_ACTION: VerifierAction = "block";

/** Fails if trimmed content is empty. */
export function nonEmpty(action: VerifierAction = DEFAULT_ACTION): DeterministicCheck {
  return {
    name: "non-empty",
    check: (content) => content.trim().length > 0 || "Output must not be empty",
    action,
  };
}

/** Fails if content exceeds `max` characters. */
export function maxLength(
  max: number,
  action: VerifierAction = DEFAULT_ACTION,
): DeterministicCheck {
  return {
    name: `max-length-${String(max)}`,
    check: (content) =>
      content.length <= max || `Output exceeds maximum length of ${String(max)} characters`,
    action,
  };
}

/** Fails if content is not valid JSON. */
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

/** Fails if content does not match the given regular expression. */
export function matchesPattern(
  pattern: RegExp,
  action: VerifierAction = DEFAULT_ACTION,
  name?: string,
): DeterministicCheck {
  // Strip stateful flags (`g`, `y`) when present so repeated `test()`
  // calls don't alternate pass/fail via mutated `lastIndex`. We rebuild
  // the regex once at construction rather than mutating per-call to
  // keep the check pure.
  const stateless =
    pattern.global || pattern.sticky
      ? new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ""))
      : pattern;
  return {
    name: name ?? `matches-${pattern.source}`,
    check: (content) =>
      stateless.test(content) || `Output does not match required pattern: ${pattern.source}`,
    action,
  };
}

/** Convenience registry of all built-in checks. */
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
