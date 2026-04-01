/**
 * Basic auth detector — matches `Basic <base64>` in authorization headers.
 */

import type { SecretMatch, SecretPattern } from "../types.js";
import { collectMatches, EMPTY_MATCHES } from "./collect.js";

// Minimum 8-char base64 to avoid false positives like "Basic example..."
const BASIC_PATTERN = /Basic\s+[A-Za-z0-9+/]{8,}=*/g;

export function createBasicAuthDetector(): SecretPattern {
  return {
    name: "basic_auth",
    kind: "basic_auth",
    detect(text: string): readonly SecretMatch[] {
      if (!text.includes("Basic")) return EMPTY_MATCHES;
      return collectMatches(text, BASIC_PATTERN, "basic_auth");
    },
  };
}
