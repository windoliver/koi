/**
 * Base64-decoding detector — decodes base64 segments and runs inner patterns
 * against the decoded content to detect encoded secret exfiltration.
 */

import type { SecretMatch, SecretPattern } from "../types.js";
import { EMPTY_MATCHES } from "./collect.js";

/**
 * Minimum base64 segment length to attempt decoding.
 * Shorter segments are overwhelmingly false positives.
 */
const MIN_BASE64_LENGTH = 20;

/**
 * Regex for base64-encoded segments: 20+ chars of [A-Za-z0-9+/] with optional = padding.
 * Uses word boundaries to avoid matching partial tokens.
 */
const BASE64_SEGMENT = /[A-Za-z0-9+/]{20,}={0,2}/g;

/**
 * Create a detector that decodes base64 segments and runs inner patterns
 * against the decoded content.
 *
 * This is a decorator pattern: it wraps existing secret detectors to catch
 * secrets that have been base64-encoded to evade direct pattern matching.
 */
export function createBase64DecodingDetector(
  innerPatterns: readonly SecretPattern[],
): SecretPattern {
  return {
    name: "base64_decode",
    kind: "base64_encoded",
    detect(text: string): readonly SecretMatch[] {
      const results: SecretMatch[] = [];
      BASE64_SEGMENT.lastIndex = 0;

      // let justified: regex exec loop variable
      let m: RegExpExecArray | null = BASE64_SEGMENT.exec(text);
      while (m !== null) {
        const segment = m[0];
        if (segment.length >= MIN_BASE64_LENGTH) {
          const decoded = safeBase64Decode(segment);
          if (decoded !== undefined) {
            for (const pattern of innerPatterns) {
              const innerMatches = pattern.detect(decoded);
              for (const inner of innerMatches) {
                results.push({
                  text: segment,
                  start: m.index,
                  end: m.index + segment.length,
                  kind: `base64_encoded_${inner.kind}`,
                });
              }
            }
          }
        }
        m = BASE64_SEGMENT.exec(text);
      }

      return results.length === 0 ? EMPTY_MATCHES : results;
    },
  };
}

/**
 * Safely decode a base64 string, returning undefined on failure.
 * Uses atob which is available in Bun/Node/browser environments.
 */
function safeBase64Decode(segment: string): string | undefined {
  try {
    return atob(segment);
  } catch {
    return undefined;
  }
}
