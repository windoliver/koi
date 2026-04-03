/**
 * Generic secret detector — matches `password=`, `api_key=`, `secret=` assignment patterns
 * in unstructured strings (log lines, config fragments, CLI output).
 *
 * This is the highest false-positive-risk pattern. Mitigations:
 * - Minimum 8-char value length
 * - Excludes known placeholder values ([REDACTED], ***, <placeholder>, etc.)
 */

import type { SecretMatch, SecretPattern } from "../types.js";
import { EMPTY_MATCHES } from "./collect.js";

const GENERIC_PATTERN =
  /(?:password|passwd|pwd|secret|api_?key|token|auth_?token|access_?key|private_?key|client_?secret)[\s]*[=:]\s*['"]?([^\s'"]{8,120})/gi;

/** Signal keywords — lowercase for case-insensitive check. */
const SIGNAL_KEYWORDS = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "apikey",
  "api_key",
  "token",
  "auth_token",
  "authtoken",
  "access_key",
  "accesskey",
  "private_key",
  "privatekey",
  "client_secret",
  "clientsecret",
] as const;

/** Values that are clearly not real secrets. */
const PLACEHOLDER_VALUES = new Set([
  "[redacted]",
  "[redacted_oversized]",
  "[redaction_failed]",
  "***",
  "****",
  "*****",
  "<placeholder>",
  "<secret>",
  "<password>",
  "changeme",
  "password",
  "example",
  "xxxxxxxx",
]);

function hasSignal(text: string): boolean {
  const lower = text.toLowerCase();
  for (const keyword of SIGNAL_KEYWORDS) {
    if (lower.includes(keyword)) return true;
  }
  return false;
}

export function createGenericSecretDetector(): SecretPattern {
  return {
    name: "generic_secret",
    kind: "generic_secret",
    detect(text: string): readonly SecretMatch[] {
      if (!hasSignal(text)) return EMPTY_MATCHES;

      const results: SecretMatch[] = [];
      GENERIC_PATTERN.lastIndex = 0;

      // let justified: regex exec loop variable
      let m: RegExpExecArray | null = GENERIC_PATTERN.exec(text);
      while (m !== null) {
        const capturedValue = m[1];
        // Skip placeholder/dummy values
        if (capturedValue !== undefined && !PLACEHOLDER_VALUES.has(capturedValue.toLowerCase())) {
          results.push({
            text: m[0],
            start: m.index,
            end: m.index + m[0].length,
            kind: "generic_secret",
          });
        }
        m = GENERIC_PATTERN.exec(text);
      }

      return results.length === 0 ? EMPTY_MATCHES : results;
    },
  };
}
