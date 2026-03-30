/**
 * ToolRegistration for @koi/tools-github — self-describing registration descriptor.
 *
 * Exports a factory that creates a ToolRegistration given a GithubProviderConfig.
 * This bridges the gap between the generic ToolRegistration pattern (which uses
 * Agent + JsonObject) and the GitHub provider's richer config (which includes
 * GhExecutor and other non-serializable deps).
 *
 * Usage in a manifest:
 *   tools:
 *     - name: github_pr_create
 *       package: "@koi/tools-github"
 */

import type { ToolRegistration } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { type GithubOperation, OPERATIONS, policyForOperation } from "./constants.js";
import type { GhExecutor } from "./gh-executor.js";
import type { GithubProviderConfig } from "./github-component-provider.js";
import { createGithubCiWaitTool } from "./tools/ci-wait.js";
import { createGithubPrCreateTool } from "./tools/pr-create.js";
import { createGithubPrMergeTool } from "./tools/pr-merge.js";
import { createGithubPrReviewTool } from "./tools/pr-review.js";
import { createGithubPrStatusTool } from "./tools/pr-status.js";

type ToolFactory = (
  executor: GhExecutor,
  prefix: string,
  policy: import("@koi/core").ToolPolicy,
) => import("@koi/core").Tool;

const TOOL_FACTORIES: Readonly<Record<GithubOperation, ToolFactory>> = {
  pr_create: createGithubPrCreateTool,
  pr_status: createGithubPrStatusTool,
  pr_review: createGithubPrReviewTool,
  pr_merge: createGithubPrMergeTool,
  ci_wait: createGithubCiWaitTool,
};

/**
 * Create a ToolRegistration for GitHub tools.
 *
 * Call this with a GithubProviderConfig and export the result as `registration`.
 * The engine's auto-resolution will pick it up from the `package` field.
 */
export function createGithubRegistration(config: GithubProviderConfig): ToolRegistration {
  const {
    executor,
    policy = DEFAULT_UNSANDBOXED_POLICY,
    prefix = "github",
    operations = OPERATIONS,
  } = config;

  return {
    name: "github",
    tools: operations.map((op) => ({
      name: `${prefix}_${op}`,
      create: () => {
        const tier = policyForOperation(op, policy);
        return TOOL_FACTORIES[op](executor, prefix, tier);
      },
    })),
  };
}
