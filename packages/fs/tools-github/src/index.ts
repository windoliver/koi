/**
 * @koi/tools-github — GitHub CLI tools for PR lifecycle management (Layer 2)
 *
 * Provides a ComponentProvider that wraps a GhExecutor as Tool components.
 * Engines discover these tools via `agent.query<Tool>("tool:")` with zero
 * engine changes.
 *
 * 5 tools: pr_create, pr_status, pr_review, pr_merge, ci_wait.
 *
 * Depends on @koi/core only — never on L1 or peer L2 packages.
 *
 * Usage:
 * ```ts
 * import { createGithubProvider, createGhExecutor } from "@koi/tools-github";
 *
 * const executor = await createGhExecutor({ cwd: "/path/to/repo" });
 * const provider = createGithubProvider({ executor });
 * ```
 */

// constants
export type { GithubOperation, MergeStrategy, ReviewAction, ReviewEvent } from "./constants.js";
export {
  DEFAULT_CI_POLL_INTERVAL_MS,
  DEFAULT_CI_TIMEOUT_MS,
  DEFAULT_PREFIX,
  GITHUB_SYSTEM_PROMPT,
  MAX_CI_TIMEOUT_MS,
  MERGE_STRATEGIES,
  MIN_CI_POLL_INTERVAL_MS,
  OPERATIONS,
  READ_OPERATIONS,
  REVIEW_ACTIONS,
  REVIEW_EVENTS,
  WRITE_OPERATIONS,
} from "./constants.js";
// executor
export type { GhExecuteOptions, GhExecutor, GhExecutorConfig } from "./gh-executor.js";
export { createGhExecutor } from "./gh-executor.js";
// provider
export type { GithubProviderConfig } from "./github-component-provider.js";
export { createGithubProvider } from "./github-component-provider.js";
// error mapping
export { isRecord, mapErrorResult, parseGhError, parseGhJson } from "./parse-gh-error.js";
export type { MockGhResponse } from "./test-helpers.js";
// test helpers
export {
  createMockAgent,
  createMockGhExecutor,
  mockError,
  mockSuccess,
  mockSuccessRaw,
} from "./test-helpers.js";
// tool factories — for advanced usage (custom tool composition)
export { createGithubCiWaitTool } from "./tools/ci-wait.js";
export { createGithubPrCreateTool } from "./tools/pr-create.js";
export { createGithubPrMergeTool } from "./tools/pr-merge.js";
export { createGithubPrReviewTool } from "./tools/pr-review.js";
export { createGithubPrStatusTool } from "./tools/pr-status.js";
