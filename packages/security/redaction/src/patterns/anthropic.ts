/**
 * Anthropic API key detector — matches `sk-ant-api03-` and `sk-ant-admin01-` prefixed keys.
 */

import type { SecretMatch, SecretPattern } from "../types.js";
import { collectMatches, EMPTY_MATCHES } from "./collect.js";

const ANTHROPIC_PATTERN = /sk-ant-(?:api03|admin01)-[A-Za-z0-9_-]{80,100}/g;

export function createAnthropicDetector(): SecretPattern {
  return {
    name: "anthropic_api_key",
    kind: "anthropic_api_key",
    detect(text: string): readonly SecretMatch[] {
      if (!text.includes("sk-ant-")) return EMPTY_MATCHES;
      return collectMatches(text, ANTHROPIC_PATTERN, "anthropic_api_key");
    },
  };
}
