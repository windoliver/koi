/**
 * Constants for @koi/tools-github — tool names, operations, trust tiers, and system prompt.
 */

import type { TrustTier } from "@koi/core";

/** All GitHub operation names. */
export const OPERATIONS = ["pr_create", "pr_status", "pr_review", "pr_merge", "ci_wait"] as const;

export type GithubOperation = (typeof OPERATIONS)[number];

/** Default tool name prefix for GitHub tools. */
export const DEFAULT_PREFIX = "github" as const;

/** Write operations require promoted trust tier. */
export const WRITE_OPERATIONS: readonly GithubOperation[] = [
  "pr_create",
  "pr_review",
  "pr_merge",
] as const;

/** Read operations use the configured trust tier (default: verified). */
export const READ_OPERATIONS: readonly GithubOperation[] = ["pr_status", "ci_wait"] as const;

/** Resolve the trust tier for an operation — write ops are always promoted. */
export function trustTierForOperation(op: GithubOperation, configTier: TrustTier): TrustTier {
  return (WRITE_OPERATIONS as readonly string[]).includes(op) ? "promoted" : configTier;
}

/** Merge strategies for PR merge. */
export const MERGE_STRATEGIES = ["merge", "squash", "rebase"] as const;
export type MergeStrategy = (typeof MERGE_STRATEGIES)[number];

/** Review event types for PR review. */
export const REVIEW_EVENTS = ["APPROVE", "REQUEST_CHANGES", "COMMENT"] as const;
export type ReviewEvent = (typeof REVIEW_EVENTS)[number];

/** Review action types — read or post. */
export const REVIEW_ACTIONS = ["post", "read"] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

/** Default CI wait configuration. */
export const DEFAULT_CI_TIMEOUT_MS = 600_000;
export const MAX_CI_TIMEOUT_MS = 1_800_000;
export const DEFAULT_CI_POLL_INTERVAL_MS = 10_000;
export const MIN_CI_POLL_INTERVAL_MS = 5_000;

/**
 * JSON fields requested per tool — minimal set to reduce spawn overhead.
 */
export const PR_CREATE_FIELDS = "number,url,headRefName" as const;
export const PR_STATUS_FIELDS =
  "state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,headRefName,baseRefName,title,additions,deletions,changedFiles" as const;
export const PR_REVIEW_READ_FIELDS = "reviews,latestReviews,reviewDecision" as const;
export const CI_WAIT_FIELDS = "statusCheckRollup" as const;

/**
 * System prompt guidance for agents using GitHub tools.
 *
 * Include this in your agent's system prompt or koi.yaml `instructions` field
 * to prime the agent with PR lifecycle best practices.
 */
export const GITHUB_SYSTEM_PROMPT: string = `
## GitHub PR lifecycle — best practices

When working with pull requests, follow this workflow:

1. **Create PR** — use \`github_pr_create\` after pushing your branch.
   Provide a clear title and body. Use \`--draft\` if the PR is not ready for review.

2. **Check status** — use \`github_pr_status\` to inspect:
   - CI check results (statusCheckRollup)
   - Review decision (approved / changes_requested / review_required)
   - Merge readiness (mergeable state)

3. **Wait for CI** — use \`github_ci_wait\` to poll CI checks until completion.
   Set \`fail_fast: true\` to stop on the first failing check.

4. **Review** — use \`github_pr_review\` to read existing reviews or post a new one.
   Always include a body when requesting changes.

5. **Merge** — use \`github_pr_merge\` only when:
   - All required checks pass
   - Reviews are approved
   - No merge conflicts

## Error handling

| Code        | Meaning                           | What to do                              |
|-------------|-----------------------------------|-----------------------------------------|
| VALIDATION  | Bad argument                      | Fix the argument and retry              |
| NOT_FOUND   | PR or resource doesn't exist      | Check PR number, verify it exists       |
| PERMISSION  | Insufficient permissions          | Check gh auth status                    |
| CONFLICT    | PR already exists / merge conflict| Check existing PRs or resolve conflicts |
| RATE_LIMIT  | GitHub API rate limit hit         | Wait and retry (retryable)              |
| EXTERNAL    | CLI or network failure            | Check gh auth, network connectivity     |
`.trim();
