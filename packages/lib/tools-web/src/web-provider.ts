/**
 * ComponentProvider that attaches web_fetch and web_search tools to an agent.
 */

import type { Agent, ComponentProvider, ToolPolicy } from "@koi/core";
import { COMPONENT_PRIORITY, toolToken } from "@koi/core";
import type { WebOperation } from "./constants.js";
import { DEFAULT_WEB_PREFIX, WEB_OPERATIONS } from "./constants.js";
import type { WebExecutor } from "./web-executor.js";
import { createWebFetchTool } from "./web-fetch-tool.js";
import { createWebSearchTool } from "./web-search-tool.js";

export interface WebProviderConfig {
  readonly executor: WebExecutor;
  readonly prefix?: string | undefined;
  /** Policy for all web tools. Required — no default to prevent silent unsandboxed egress. */
  readonly policy: ToolPolicy;
  readonly operations?: readonly WebOperation[] | undefined;
}

export function createWebProvider(config: WebProviderConfig): ComponentProvider {
  const { executor, prefix = DEFAULT_WEB_PREFIX, policy, operations = WEB_OPERATIONS } = config;

  const factories: Record<WebOperation, () => unknown> = {
    fetch: () => createWebFetchTool(executor, prefix, policy),
    search: () => createWebSearchTool(executor, prefix, policy),
  };

  return {
    name: "web-tools",
    priority: COMPONENT_PRIORITY.BUNDLED,
    attach: async (_agent: Agent): Promise<ReadonlyMap<string, unknown>> => {
      const entries: [string, unknown][] = [];
      for (const op of operations) {
        const factory = factories[op];
        entries.push([toolToken(`${prefix}_${op}`), factory()]);
      }
      return new Map(entries);
    },
  };
}
