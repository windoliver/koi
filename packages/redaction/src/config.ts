/**
 * Configuration validation + defaults for createRedactor().
 */

import type { KoiError, Result } from "@koi/core";
import { createAllSecretPatterns, DEFAULT_SENSITIVE_FIELDS } from "./patterns/index.js";
import type { RedactionConfig } from "./types.js";

/** Default configuration for createRedactor(). */
export const DEFAULT_REDACTION_CONFIG: RedactionConfig = {
  patterns: createAllSecretPatterns(),
  customPatterns: [],
  fieldNames: DEFAULT_SENSITIVE_FIELDS,
  censor: "redact",
  fieldCensor: "redact",
  maxDepth: 10,
  maxStringLength: 100_000,
  onError: undefined,
};

/** Maximum time (ms) allowed for a custom pattern to execute against adversarial input. */
const REDOS_THRESHOLD_MS = 5;

/** Adversarial inputs for ReDoS detection — multiple patterns to catch diverse backtracking triggers. */
const ADVERSARIAL_INPUTS = [
  "a".repeat(50),
  "a]a]a]a]a]a]a]a]a]a]".repeat(5),
  `-----BEGIN a PRIVATE KEY-----${"x".repeat(50)}`,
  `eyJ${".".repeat(50)}`,
] as const;

/**
 * Validate a partial redaction config and merge with defaults.
 * Returns a fully resolved `RedactionConfig` or a validation error.
 */
export function validateRedactionConfig(config: unknown): Result<RedactionConfig, KoiError> {
  if (config !== undefined && config !== null && typeof config !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "RedactionConfig must be an object or undefined",
        retryable: false,
      },
    };
  }

  const raw = (config ?? {}) as Record<string, unknown>;

  // Validate maxDepth
  if (raw.maxDepth !== undefined) {
    if (typeof raw.maxDepth !== "number" || raw.maxDepth < 1) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "maxDepth must be a positive number",
          retryable: false,
        },
      };
    }
  }

  // Validate maxStringLength
  if (raw.maxStringLength !== undefined) {
    if (typeof raw.maxStringLength !== "number" || raw.maxStringLength < 1) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "maxStringLength must be a positive number",
          retryable: false,
        },
      };
    }
  }

  // Validate censor
  if (raw.censor !== undefined) {
    const c = raw.censor;
    if (typeof c !== "function" && c !== "redact" && c !== "mask" && c !== "remove") {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: 'censor must be "redact", "mask", "remove", or a function',
          retryable: false,
        },
      };
    }
  }

  // Validate fieldCensor
  if (raw.fieldCensor !== undefined) {
    const fc = raw.fieldCensor;
    if (typeof fc !== "function" && fc !== "redact" && fc !== "mask" && fc !== "remove") {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: 'fieldCensor must be "redact", "mask", "remove", or a function',
          retryable: false,
        },
      };
    }
  }

  const merged: RedactionConfig = {
    patterns: Array.isArray(raw.patterns)
      ? (raw.patterns as RedactionConfig["patterns"])
      : DEFAULT_REDACTION_CONFIG.patterns,
    customPatterns: Array.isArray(raw.customPatterns)
      ? (raw.customPatterns as RedactionConfig["customPatterns"])
      : DEFAULT_REDACTION_CONFIG.customPatterns,
    fieldNames: Array.isArray(raw.fieldNames)
      ? (raw.fieldNames as RedactionConfig["fieldNames"])
      : DEFAULT_REDACTION_CONFIG.fieldNames,
    censor:
      (raw.censor as RedactionConfig["censor"] | undefined) ?? DEFAULT_REDACTION_CONFIG.censor,
    fieldCensor:
      (raw.fieldCensor as RedactionConfig["fieldCensor"] | undefined) ??
      DEFAULT_REDACTION_CONFIG.fieldCensor,
    maxDepth: (raw.maxDepth as number | undefined) ?? DEFAULT_REDACTION_CONFIG.maxDepth,
    maxStringLength:
      (raw.maxStringLength as number | undefined) ?? DEFAULT_REDACTION_CONFIG.maxStringLength,
    onError: (raw.onError as RedactionConfig["onError"]) ?? DEFAULT_REDACTION_CONFIG.onError,
  };

  // ReDoS safety check for custom patterns — always runs (fail-closed)
  for (const pattern of merged.customPatterns) {
    for (const adversarial of ADVERSARIAL_INPUTS) {
      const start = performance.now();
      pattern.detect(adversarial);
      const elapsed = performance.now() - start;
      if (elapsed > REDOS_THRESHOLD_MS) {
        const message = `Custom pattern "${pattern.name}" took ${elapsed.toFixed(1)}ms on adversarial input — possible ReDoS`;
        merged.onError?.(new Error(message));
        return {
          ok: false,
          error: {
            code: "VALIDATION" as const,
            message,
            retryable: false,
          },
        };
      }
    }
  }

  return { ok: true, value: merged };
}
