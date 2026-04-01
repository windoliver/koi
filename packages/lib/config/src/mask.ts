/**
 * Sensitive field masking for safe config logging.
 */

/** Default pattern matching sensitive field names. */
export const SENSITIVE_PATTERN: RegExp = /(?:api[_-]?key|secret|password|token|credential|auth)/i;

const MASK_VALUE = "***";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively redacts fields whose keys match `pattern`.
 *
 * Returns a new object — the input is never mutated.
 */
export function maskConfig(
  obj: Readonly<Record<string, unknown>>,
  pattern: RegExp = SENSITIVE_PATTERN,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const key of Object.keys(obj)) {
    const value = obj[key];

    if (pattern.test(key)) {
      result[key] = MASK_VALUE;
    } else if (isPlainObject(value)) {
      result[key] = maskConfig(value, pattern);
    } else {
      result[key] = value;
    }
  }

  return result;
}
