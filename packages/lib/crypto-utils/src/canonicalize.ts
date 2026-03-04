/**
 * Deterministic JSON canonicalization — recursively sorts object keys
 * to produce consistent serialization regardless of insertion order.
 *
 * Used by HMAC and Ed25519 verifiers to reproduce the canonical payload
 * that was signed at token issuance time.
 */

/** Type guard: narrows non-null, non-array object to indexable record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Recursively sorts object keys to produce deterministic JSON.
 * - Primitive values pass through unchanged
 * - Arrays are recursively processed element-wise
 * - Objects have their keys sorted lexicographically
 */
export function sortKeys(value: unknown): unknown {
  if (!isRecord(value)) {
    return Array.isArray(value) ? value.map(sortKeys) : value;
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortKeys(value[key]);
  }
  return sorted;
}

/**
 * Produces a canonical JSON string from a value (typically an object).
 * Keys are recursively sorted to ensure deterministic output.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
