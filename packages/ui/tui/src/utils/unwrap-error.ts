/**
 * Deep-parse an error message string, unwrapping nested JSON encoding.
 *
 * Many error responses arrive as:
 * - Double-encoded JSON: `"{\"error\":\"actual message\"}"`
 * - Nested objects: `{"error":{"message":"actual message"}}`
 * - Simple strings: `"Connection refused"`
 *
 * This function extracts the most useful human-readable message.
 */
export function unwrapErrorMessage(raw: string): string {
  return unwrapRecursive(raw, 0);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const MAX_DEPTH = 3;

function unwrapRecursive(raw: string, depth: number): string {
  if (depth >= MAX_DEPTH) return raw;
  if (raw === "" || !looksLikeJson(raw)) return raw;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }

  // Double-encoded string — parse again
  if (typeof parsed === "string") {
    return unwrapRecursive(parsed, depth + 1);
  }

  // Only handle plain objects — arrays and primitives are not error shapes
  if (!isPlainObject(parsed)) return raw;

  const obj = parsed as Readonly<Record<string, unknown>>;

  // { error: { message: "..." } }
  if (isPlainObject(obj.error)) {
    const inner = obj.error as Readonly<Record<string, unknown>>;
    if (typeof inner.message === "string") {
      return unwrapRecursive(inner.message, depth + 1);
    }
    // error is an object without a message field — stringify the inner object
    return raw;
  }

  // { error: "..." }
  if (typeof obj.error === "string") {
    return unwrapRecursive(obj.error, depth + 1);
  }

  // { message: "..." }
  if (typeof obj.message === "string") {
    return unwrapRecursive(obj.message, depth + 1);
  }

  // { detail: "..." }
  if (typeof obj.detail === "string") {
    return unwrapRecursive(obj.detail, depth + 1);
  }

  return raw;
}

function looksLikeJson(s: string): boolean {
  const first = s[0];
  return first === "{" || first === "[" || first === '"';
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
