/**
 * Redactor factory — compile-once, use-many secret masking engine.
 */

import { validateRedactionConfig } from "./config.js";
import { createFieldMatcher } from "./field-match.js";
import { scanSecrets } from "./scan-string.js";
import type {
  RedactionConfig,
  RedactObjectResult,
  Redactor,
  RedactStringResult,
  SecretPattern,
} from "./types.js";
import { walkAndRedact } from "./walk.js";

/** Fail-closed fallback for redactString when an error occurs. */
const FAILED_STRING_RESULT: RedactStringResult = {
  text: "[REDACTION_FAILED]",
  changed: true,
  matchCount: -1,
};

/**
 * Create a compiled redactor from the given config.
 * Validates config at construction and pre-compiles patterns and field matcher.
 * Fail-closed: on any runtime error, returns `[REDACTION_FAILED]` and calls `onError`.
 */
export function createRedactor(config?: Partial<RedactionConfig>): Redactor {
  const validated = validateRedactionConfig(config);
  if (!validated.ok) {
    throw new Error(`Invalid redaction config: ${validated.error.message}`);
  }

  const cfg = validated.value;

  // Defense-in-depth: re-snapshot every pattern into a redactor-owned frozen
  // wrapper. The validator already snapshots untrusted patterns and trusted
  // built-ins are frozen by `markTrusted`, but this boundary guarantees the
  // runtime never holds a reference to any caller-visible pattern object.
  // The safety invariant doesn't depend on a distant guarantee from
  // `markTrusted` or on every upstream code path preserving immutability.
  const allPatterns: readonly SecretPattern[] = [...cfg.patterns, ...cfg.customPatterns].map((p) =>
    Object.freeze({ name: p.name, kind: p.kind, detect: p.detect }),
  );

  // Pre-compile field matcher
  const fieldMatcher = createFieldMatcher(cfg.fieldNames);

  const walkContext = Object.freeze({
    patterns: allPatterns,
    fieldMatcher,
    censor: cfg.censor,
    fieldCensor: cfg.fieldCensor,
    maxDepth: cfg.maxDepth,
    maxStringLength: cfg.maxStringLength,
  });

  const redactor: Redactor = {
    redactObject<T>(value: T): RedactObjectResult<T> {
      try {
        return walkAndRedact(value, walkContext);
      } catch (e: unknown) {
        cfg.onError?.(e);
        // Fail-closed: secretCount/fieldCount === -1 signals failure.
        // Callers MUST check these sentinel values before trusting `value`.
        // Cast justified: fail-closed sentinel — value is intentionally not T.
        return {
          value: "[REDACTION_FAILED]" as unknown as T,
          changed: true,
          secretCount: -1,
          fieldCount: -1,
        };
      }
    },

    redactString(text: string): RedactStringResult {
      try {
        return scanSecrets(text, allPatterns, cfg.censor, cfg.maxStringLength);
      } catch (e: unknown) {
        cfg.onError?.(e);
        return FAILED_STRING_RESULT;
      }
    },
  };

  return Object.freeze(redactor);
}
