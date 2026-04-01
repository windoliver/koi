/**
 * Input parsing helpers — shared between tool implementations.
 */

/** Type guard for non-null objects (JSON-like). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Extract a required non-empty string field or return an error message. */
export function parseStringField(
  record: Record<string, unknown>,
  field: string,
): string | { readonly error: string } {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    return { error: `'${field}' is required and must be a non-empty string` };
  }
  return value;
}

/** Extract an enum field matching one of the allowed values. */
export function parseEnumField<T extends string>(
  record: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T | { readonly error: string } {
  const value = record[field];
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    return { error: `'${field}' must be one of: ${allowed.join(", ")}` };
  }
  return value as T;
}
