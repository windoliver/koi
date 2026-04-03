/**
 * PEM private key detector — matches `-----BEGIN ... PRIVATE KEY-----` blocks.
 */

import type { SecretMatch, SecretPattern } from "../types.js";
import { collectMatches, EMPTY_MATCHES } from "./collect.js";

// Constrained character class avoids catastrophic backtracking on large inputs without END marker.
const PEM_PATTERN =
  /-----BEGIN[A-Z ]+PRIVATE KEY-----[A-Za-z0-9+/=\s]{1,10000}-----END[A-Z ]+PRIVATE KEY-----/g;

export function createPEMDetector(): SecretPattern {
  return {
    name: "pem_private_key",
    kind: "pem_private_key",
    detect(text: string): readonly SecretMatch[] {
      if (!text.includes("-----BEGIN")) return EMPTY_MATCHES;
      return collectMatches(text, PEM_PATTERN, "pem_private_key");
    },
  };
}
