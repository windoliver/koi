/**
 * GitHub token detector — matches `ghp_` and `ghs_` prefixed tokens.
 */

import type { SecretMatch, SecretPattern } from "../types.js";
import { collectMatches, EMPTY_MATCHES } from "./collect.js";

const GITHUB_PATTERN = /gh[ps]_[A-Za-z0-9_]{36,}/g;

export function createGitHubDetector(): SecretPattern {
  return {
    name: "github_token",
    kind: "github_token",
    detect(text: string): readonly SecretMatch[] {
      if (!text.includes("ghp_") && !text.includes("ghs_")) return EMPTY_MATCHES;
      return collectMatches(text, GITHUB_PATTERN, "github_token");
    },
  };
}
