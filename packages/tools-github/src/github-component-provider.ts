/**
 * GitHub ComponentProvider — attaches GitHub Tool components to an agent.
 *
 * Engines discover tools via `agent.query<Tool>("tool:")`.
 * This provider creates Tool components from a GhExecutor, making them
 * available to any engine with zero engine changes.
 */

import type { Agent, ComponentProvider, Tool, TrustTier } from "@koi/core";
import { toolToken } from "@koi/core";
import { type GithubOperation, OPERATIONS, trustTierForOperation } from "./constants.js";
import type { GhExecutor } from "./gh-executor.js";
import { createGithubCiWaitTool } from "./tools/ci-wait.js";
import { createGithubPrCreateTool } from "./tools/pr-create.js";
import { createGithubPrMergeTool } from "./tools/pr-merge.js";
import { createGithubPrReviewTool } from "./tools/pr-review.js";
import { createGithubPrStatusTool } from "./tools/pr-status.js";

export interface GithubProviderConfig {
  readonly executor: GhExecutor;
  /** Default trust tier for read operations (default: "verified"). */
  readonly trustTier?: TrustTier;
  /** Tool name prefix (default: "github"). */
  readonly prefix?: string;
  /** Operations to include (default: all 5). */
  readonly operations?: readonly GithubOperation[];
}

type ToolFactory = (executor: GhExecutor, prefix: string, trustTier: TrustTier) => Tool;

const TOOL_FACTORIES: Readonly<Record<GithubOperation, ToolFactory>> = {
  pr_create: createGithubPrCreateTool,
  pr_status: createGithubPrStatusTool,
  pr_review: createGithubPrReviewTool,
  pr_merge: createGithubPrMergeTool,
  ci_wait: createGithubCiWaitTool,
};

export function createGithubProvider(config: GithubProviderConfig): ComponentProvider {
  const { executor, trustTier = "verified", prefix = "github", operations = OPERATIONS } = config;

  return {
    name: `github:${prefix}`,

    attach: async (_agent: Agent): Promise<ReadonlyMap<string, unknown>> => {
      const entries: ReadonlyMap<string, unknown> = new Map(
        operations.map((op) => {
          const tier = trustTierForOperation(op, trustTier);
          const factory = TOOL_FACTORIES[op];
          const tool = factory(executor, prefix, tier);
          // SubsystemToken<T> extends string — safe to use as Map key directly
          const key: string = toolToken(tool.descriptor.name);
          return [key, tool] as const;
        }),
      );
      return entries;
    },
  };
}
