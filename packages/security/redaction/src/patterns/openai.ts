/**
 * OpenAI API key detector — matches `sk-proj-`, `sk-svcacct-`, `sk-admin-` prefixed keys.
 */

import type { SecretMatch, SecretPattern } from "../types.js";
import { collectMatches, EMPTY_MATCHES } from "./collect.js";

// Modern project/service-account/admin keys
const OPENAI_PATTERN = /sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,180}/g;

export function createOpenAIDetector(): SecretPattern {
  return {
    name: "openai_api_key",
    kind: "openai_api_key",
    detect(text: string): readonly SecretMatch[] {
      if (
        !text.includes("sk-proj-") &&
        !text.includes("sk-svcacct-") &&
        !text.includes("sk-admin-")
      )
        return EMPTY_MATCHES;
      return collectMatches(text, OPENAI_PATTERN, "openai_api_key");
    },
  };
}
