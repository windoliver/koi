/**
 * Credential URI detector — matches database/service connection strings with embedded passwords.
 * Covers: mongodb, postgres, mysql, redis, amqp (and their TLS variants).
 */

import type { SecretMatch, SecretPattern } from "../types.js";
import { collectMatches, EMPTY_MATCHES } from "./collect.js";

const CREDENTIAL_URI_PATTERN =
  /(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|rediss?|amqps?):\/\/[^\s:]+:[^\s@]+@[^\s]+/gi;

/** Known database/service URI scheme prefixes for fast-path check. */
const SIGNAL_PREFIXES = [
  "mongodb://",
  "mongodb+srv://",
  "postgres://",
  "postgresql://",
  "mysql://",
  "redis://",
  "rediss://",
  "amqp://",
  "amqps://",
] as const;

function hasSignal(text: string): boolean {
  const lower = text.toLowerCase();
  for (const prefix of SIGNAL_PREFIXES) {
    if (lower.includes(prefix)) return true;
  }
  return false;
}

export function createCredentialURIDetector(): SecretPattern {
  return {
    name: "credential_uri",
    kind: "credential_uri",
    detect(text: string): readonly SecretMatch[] {
      if (!hasSignal(text)) return EMPTY_MATCHES;
      return collectMatches(text, CREDENTIAL_URI_PATTERN, "credential_uri");
    },
  };
}
