/**
 * Bearer token detector — matches `Bearer <token>` in authorization headers.
 */

import type { SecretMatch, SecretPattern } from "../types.js";
import { collectMatches, EMPTY_MATCHES } from "./collect.js";

// Minimum 8-char token to avoid false positives like "Bearer in mind that..."
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9\-._~+/]{8,}=*/g;

export function createBearerDetector(): SecretPattern {
  return {
    name: "bearer_token",
    kind: "bearer_token",
    detect(text: string): readonly SecretMatch[] {
      if (!text.includes("Bearer")) return EMPTY_MATCHES;
      return collectMatches(text, BEARER_PATTERN, "bearer_token");
    },
  };
}
