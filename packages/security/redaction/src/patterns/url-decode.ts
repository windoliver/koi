/**
 * URL-decoding detector — decodes URL-encoded segments and runs inner patterns
 * against the decoded content to detect encoded secret exfiltration.
 */

import type { SecretMatch, SecretPattern } from "../types.js";
import { EMPTY_MATCHES } from "./collect.js";

/**
 * Minimum number of percent-encoded sequences required before attempting decode.
 * A single %20 is normal; 3+ encoded sequences suggest intentional encoding.
 */
const MIN_ENCODED_SEQUENCES = 3;

/**
 * Regex matching strings containing percent-encoded sequences.
 * Matches URL-like segments with at least MIN_ENCODED_SEQUENCES percent pairs.
 */
const URL_ENCODED_SEGMENT = /(?:[A-Za-z0-9_.~:/?#[\]@!$&'()*+,;=-]|%[0-9A-Fa-f]{2}){10,}/g;

/** Count the number of percent-encoded pairs in a string. */
function countPercentPairs(text: string): number {
  const matches = text.match(/%[0-9A-Fa-f]{2}/g);
  return matches === null ? 0 : matches.length;
}

/**
 * Create a detector that decodes URL-encoded segments and runs inner patterns
 * against the decoded content.
 *
 * This is a decorator pattern: it wraps existing secret detectors to catch
 * secrets that have been URL-encoded to evade direct pattern matching.
 */
export function createUrlDecodingDetector(innerPatterns: readonly SecretPattern[]): SecretPattern {
  return {
    name: "url_decode",
    kind: "url_encoded",
    detect(text: string): readonly SecretMatch[] {
      // Fast path: no percent signs means no URL encoding
      if (!text.includes("%")) return EMPTY_MATCHES;

      const results: SecretMatch[] = [];
      URL_ENCODED_SEGMENT.lastIndex = 0;

      // let justified: regex exec loop variable
      let m: RegExpExecArray | null = URL_ENCODED_SEGMENT.exec(text);
      while (m !== null) {
        const segment = m[0];
        if (countPercentPairs(segment) >= MIN_ENCODED_SEQUENCES) {
          const decoded = safeUrlDecode(segment);
          if (decoded !== undefined && decoded !== segment) {
            for (const pattern of innerPatterns) {
              const innerMatches = pattern.detect(decoded);
              for (const inner of innerMatches) {
                results.push({
                  text: segment,
                  start: m.index,
                  end: m.index + segment.length,
                  kind: `url_encoded_${inner.kind}`,
                });
              }
            }
          }
        }
        m = URL_ENCODED_SEGMENT.exec(text);
      }

      return results.length === 0 ? EMPTY_MATCHES : results;
    },
  };
}

/**
 * Safely decode a URL-encoded string, returning undefined on failure.
 */
function safeUrlDecode(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}
