/**
 * Web ComponentProvider — attaches web Tool components to an agent.
 *
 * Engines discover tools via `agent.query<Tool>("tool:")`.
 * This provider creates Tool components from a WebExecutor, making them
 * available to any engine with zero engine changes.
 */

import type { Agent, ComponentProvider, Tool, ToolPolicy } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY, skillToken, toolToken } from "@koi/core";
import { OPERATIONS, type WebOperation } from "./constants.js";
import { WEB_SKILL, WEB_SKILL_NAME } from "./skill.js";
import { createWebFetchTool } from "./tools/web-fetch.js";
import { createWebSearchTool } from "./tools/web-search.js";
import type { WebExecutor } from "./web-executor.js";

export interface WebProviderConfig {
  readonly executor: WebExecutor;
  /** Default trust tier for all operations (default: "verified"). */
  readonly policy?: ToolPolicy | undefined;
  /** Tool name prefix (default: "web"). */
  readonly prefix?: string | undefined;
  /** Operations to include (default: all). */
  readonly operations?: readonly WebOperation[] | undefined;
}

type ToolFactory = (executor: WebExecutor, prefix: string, policy: ToolPolicy) => Tool;

const TOOL_FACTORIES: Readonly<Record<WebOperation, ToolFactory>> = {
  fetch: createWebFetchTool,
  search: createWebSearchTool,
};

export function createWebProvider(config: WebProviderConfig): ComponentProvider {
  const {
    executor,
    policy = DEFAULT_UNSANDBOXED_POLICY,
    prefix = "web",
    operations = OPERATIONS,
  } = config;

  return {
    name: `web:${prefix}`,

    attach: async (_agent: Agent): Promise<ReadonlyMap<string, unknown>> => {
      const toolEntries = operations.map((op) => {
        const factory = TOOL_FACTORIES[op];
        const tool = factory(executor, prefix, policy);
        const key: string = toolToken(tool.descriptor.name);
        return [key, tool] as const;
      });
      return new Map<string, unknown>([
        ...toolEntries,
        [skillToken(WEB_SKILL_NAME) as string, WEB_SKILL],
      ]);
    },
  };
}
