/**
 * Shared regex match collection utility for secret pattern detectors.
 */

import type { SecretMatch } from "../types.js";

/** Pre-allocated empty array for zero-allocation fast paths. */
export const EMPTY_MATCHES: readonly SecretMatch[] = [];

/**
 * Collect all regex matches in a string, optionally validating each.
 * Resets lastIndex before scanning for safe reuse of global regexps.
 */
export function collectMatches(
  text: string,
  pattern: RegExp,
  kind: string,
  validate?: (match: string) => boolean,
): readonly SecretMatch[] {
  const results: SecretMatch[] = [];
  pattern.lastIndex = 0;

  // let justified: regex exec loop variable
  let m: RegExpExecArray | null = pattern.exec(text);
  while (m !== null) {
    const matchText = m[0];
    if (validate === undefined || validate(matchText)) {
      results.push({
        text: matchText,
        start: m.index,
        end: m.index + matchText.length,
        kind,
      });
    }
    m = pattern.exec(text);
  }
  return results.length === 0 ? EMPTY_MATCHES : results;
}
