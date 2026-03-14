/**
 * JSON.stringify replacer that handles circular references and
 * sanitizes common secret patterns.
 *
 * Used by the JSON log mode to safely serialize arbitrary values
 * without throwing on cycles or leaking secrets.
 */

/** Patterns that indicate a value is a secret and should be redacted. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /^sk-[A-Za-z0-9]/,
  /^Bearer\s+/,
  /^ghp_[A-Za-z0-9]/,
  /^xox[bpas]-[A-Za-z0-9]/,
  /^AKIA[A-Z0-9]{12,}/,
] as const;

const REDACTED = "[REDACTED]";

function isSensitive(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Creates a JSON.stringify replacer that:
 * 1. Replaces circular references with "[Circular]"
 * 2. Redacts values matching common secret patterns
 */
export function createSafeReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();

  return (_key: string, value: unknown): unknown => {
    if (isSensitive(value)) return REDACTED;

    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
    }

    return value;
  };
}
