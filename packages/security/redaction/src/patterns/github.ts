/**
 * GitHub token detector — matches prefix-based GitHub token families:
 *
 * - `ghp_` — classic personal access tokens
 * - `ghs_` — server-to-server tokens (GitHub App installation)
 * - `gho_` — OAuth access tokens
 * - `ghu_` — user-to-server tokens
 * - `ghr_` — refresh tokens
 * - `github_pat_` — fine-grained personal access tokens
 */

import type { SecretMatch, SecretPattern } from "../types.js";
import { collectMatches, EMPTY_MATCHES } from "./collect.js";

/** Classic GitHub tokens: ghp_, ghs_, gho_, ghu_, ghr_ + 36+ alphanumeric chars. */
const GITHUB_CLASSIC_PATTERN = /gh[psuor]_[A-Za-z0-9_]{36,}/g;

/**
 * Fine-grained PATs: github_pat_ + 22 base62 + _ + 59 base62 (82 suffix chars total).
 *
 * Enforces the documented inner structure (separator at position 22, no underscores
 * inside either segment) and anchors the match between non-word boundaries so an
 * attacker-controlled `github_pat_…`-looking blob cannot redact arbitrary surrounding
 * content from logs/audit output.
 *
 * Intentional tradeoff: stricter than gitleaks' `github_pat_\w{82}`. If GitHub ever
 * changes the fine-grained PAT format, real tokens will stop redacting — revisit then.
 */
const GITHUB_PAT_PATTERN =
  /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}(?![A-Za-z0-9_])/g;

export function createGitHubDetector(): SecretPattern {
  return {
    name: "github_token",
    kind: "github_token",
    detect(text: string): readonly SecretMatch[] {
      const hasClassic =
        text.includes("ghp_") ||
        text.includes("ghs_") ||
        text.includes("gho_") ||
        text.includes("ghu_") ||
        text.includes("ghr_");
      const hasPat = text.includes("github_pat_");

      if (!hasClassic && !hasPat) return EMPTY_MATCHES;

      const matches: SecretMatch[] = [];
      if (hasClassic) matches.push(...collectMatches(text, GITHUB_CLASSIC_PATTERN, "github_token"));
      if (hasPat) matches.push(...collectMatches(text, GITHUB_PAT_PATTERN, "github_token"));
      return matches;
    },
  };
}
