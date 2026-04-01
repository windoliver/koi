/**
 * Field-name matching — Set<string> (exact, case-insensitive) + RegExp[] fallback.
 */

/** A compiled field matcher — returns true if the key is sensitive. */
export type FieldMatcher = (key: string) => boolean;

/** Always-false matcher for the no-fieldNames case. */
const NEVER_MATCH: FieldMatcher = () => false;

/**
 * Create a field matcher from a list of exact strings and RegExp patterns.
 * Strings are matched case-insensitively via Set. RegExps are tested sequentially.
 */
export function createFieldMatcher(fieldNames: readonly (string | RegExp)[]): FieldMatcher {
  if (fieldNames.length === 0) return NEVER_MATCH;

  const exactSet = new Set<string>();
  const regexps: RegExp[] = [];

  for (const name of fieldNames) {
    if (typeof name === "string") {
      exactSet.add(name.toLowerCase());
    } else {
      regexps.push(name);
    }
  }

  // Fast path: only exact matches
  if (regexps.length === 0) {
    return (key: string): boolean => exactSet.has(key.toLowerCase());
  }

  // Combined path: exact O(1) + regex O(n)
  return (key: string): boolean => {
    if (exactSet.has(key.toLowerCase())) return true;
    for (const re of regexps) {
      re.lastIndex = 0; // Reset stateful g/y regexes to avoid intermittent misses
      if (re.test(key)) return true;
    }
    return false;
  };
}
