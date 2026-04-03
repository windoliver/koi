/**
 * Agent type name validation — security boundary for agent identifiers.
 *
 * Rejects path traversal, shell injection, and poor UX names.
 * Pattern matches CC's battle-tested regex.
 */

import type { KoiError, Result } from "@koi/core";

/** Alphanumeric + hyphens, 3-50 chars, no leading/trailing hyphen. */
const AGENT_TYPE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]$/;

const MIN_LENGTH = 3;
const MAX_LENGTH = 50;

/**
 * Validate an agentType string.
 *
 * Returns the validated string on success, or a descriptive error on failure.
 * Rejects: path traversal (`../../etc`), special chars, spaces, too short/long.
 */
export function validateAgentType(agentType: string): Result<string, KoiError> {
  if (agentType.length < MIN_LENGTH) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Agent type "${agentType}" is too short (minimum ${MIN_LENGTH} characters)`,
        retryable: false,
      },
    };
  }

  if (agentType.length > MAX_LENGTH) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Agent type "${agentType}" is too long (maximum ${MAX_LENGTH} characters)`,
        retryable: false,
      },
    };
  }

  if (!AGENT_TYPE_PATTERN.test(agentType)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Agent type "${agentType}" is invalid. Must be alphanumeric with hyphens, no leading/trailing hyphens (e.g., "code-reviewer", "researcher")`,
        retryable: false,
      },
    };
  }

  return { ok: true, value: agentType };
}
