/**
 * Output sanitization for LLM extraction pass.
 *
 * Tool outputs are untrusted. Before feeding them to an extraction LLM:
 * 1. Redact secrets via @koi/redaction
 * 2. Cap payload size
 * 3. Wrap in <untrusted-data> tags to prevent prompt injection
 */

import { createAllSecretPatterns, createRedactor } from "@koi/redaction";
import { EXTRACTION_DEFAULTS } from "./types.js";

/** Lazily initialized redactor — compiled once, reused across calls. */
// let justified: lazy singleton to avoid compiling patterns on import
let cachedRedactor: ReturnType<typeof createRedactor> | undefined;

function getRedactor(): ReturnType<typeof createRedactor> {
  if (cachedRedactor === undefined) {
    cachedRedactor = createRedactor({
      patterns: createAllSecretPatterns(),
    });
  }
  return cachedRedactor;
}

/**
 * Sanitizes a tool output for safe LLM extraction.
 *
 * 1. Truncates to maxBytes
 * 2. Redacts detected secrets
 * 3. Wraps in <untrusted-data> boundary tags
 */
export function sanitizeForExtraction(
  output: string,
  maxBytes: number = EXTRACTION_DEFAULTS.maxOutputSizeBytes,
): string {
  // Truncate first to bound redaction work
  const truncated = output.length > maxBytes ? output.slice(0, maxBytes) : output;

  // Redact secrets
  const redactor = getRedactor();
  const redacted = redactor.redactString(truncated);

  // Wrap in untrusted-data boundary
  return `<untrusted-data>\n${redacted.text}\n</untrusted-data>`;
}

/**
 * Returns the number of secrets detected in the output (without modifying it).
 * Useful for telemetry / logging.
 */
export function countSecrets(output: string): number {
  const redactor = getRedactor();
  const result = redactor.redactString(output);
  return result.matchCount;
}
