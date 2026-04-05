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
 * Fine-grained PATs: `github_pat_` + 82 word chars, matching the gitleaks
 * authoritative rule `github_pat_\w{82}`. Only GitHub's `github_pat_` prefix is
 * publicly documented; inner shape (e.g. a `_` at offset 22) is observed but not
 * guaranteed, so we do NOT enforce it — enforcing an inferred layout would risk
 * silent false negatives (unredacted real tokens = secret leak) if the format
 * drifts.
 *
 * Leading lookbehind prevents attacker-injected prefixes (`xxgithub_pat_…`) from
 * anchoring a match. We deliberately do NOT require a trailing non-word boundary:
 * a real token concatenated with adjacent word chars must still redact its 93
 * known-secret chars rather than failing open. Trailing payload is left visible,
 * which is the correct tradeoff for a redaction library.
 *
 * Fixes #1494 by capping the match span to 93 chars (prefix + 82) instead of the
 * previous unbounded `{40,}` quantifier that redacted arbitrary-length payload.
 */
const GITHUB_PAT_PATTERN = /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{82}/g;

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
