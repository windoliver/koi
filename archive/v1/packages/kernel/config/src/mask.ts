/**
 * Sensitive field masking — recursively redacts secret values before logging.
 *
 * Walks a config object and replaces values whose keys match a sensitive
 * pattern with "***". Returns a new object — never mutates input.
 */

/** Default pattern matching common secret field names. */
export const SENSITIVE_PATTERN: RegExp = /(?:api[_-]?key|secret|password|token|credential|auth)/i;

const MASK_VALUE = "***";

/** Keys that must never be assigned to a plain object (prototype pollution). */
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function maskValue(value: unknown, pattern: RegExp): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => maskValue(item, pattern));
  }
  if (isPlainObject(value)) {
    return maskRecord(value, pattern);
  }
  return value;
}

function maskRecord(obj: Record<string, unknown>, pattern: RegExp): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    result[key] = pattern.test(key) ? MASK_VALUE : maskValue(obj[key], pattern);
  }
  return result;
}

/**
 * Recursively masks sensitive fields in a config object.
 *
 * @param obj - The config object to mask.
 * @param pattern - Regex to match sensitive keys. Defaults to `SENSITIVE_PATTERN`.
 * @returns A new object with sensitive values replaced by "***".
 */
export function maskConfig(
  obj: Record<string, unknown>,
  pattern: RegExp = SENSITIVE_PATTERN,
): Record<string, unknown> {
  return maskRecord(obj, pattern);
}
