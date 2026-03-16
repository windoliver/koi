/**
 * Context Hub ComponentProvider — attaches Context Hub Tool components to an agent.
 *
 * Engines discover tools via `agent.query<Tool>("tool:")`.
 * This provider creates Tool components from a ContextHubExecutor, making them
 * available to any engine with zero engine changes.
 *
 * 2 tools: chub_search, chub_get.
 */

import type { Agent, ComponentProvider, Tool, ToolPolicy } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY, skillToken, toolToken } from "@koi/core";
import type { ContextHubExecutor } from "./context-hub-executor.js";
import { CONTEXT_HUB_SKILL, CONTEXT_HUB_SKILL_NAME } from "./skill.js";
import { createChubGetTool } from "./tools/chub-get.js";
import { createChubSearchTool } from "./tools/chub-search.js";

/** Operations available in this provider. */
export const OPERATIONS = ["search", "get"] as const;

export type ContextHubOperation = (typeof OPERATIONS)[number];

export interface ContextHubProviderConfig {
  readonly executor: ContextHubExecutor;
  /** Default trust tier for all operations (default: unsandboxed). */
  readonly policy?: ToolPolicy | undefined;
  /** Tool name prefix (default: "chub"). */
  readonly prefix?: string | undefined;
  /** Operations to include (default: all). */
  readonly operations?: readonly ContextHubOperation[] | undefined;
}

type ToolFactory = (executor: ContextHubExecutor, prefix: string, policy: ToolPolicy) => Tool;

const TOOL_FACTORIES: Readonly<Record<ContextHubOperation, ToolFactory>> = {
  search: createChubSearchTool,
  get: createChubGetTool,
};

export function createContextHubProvider(config: ContextHubProviderConfig): ComponentProvider {
  const {
    executor,
    policy = DEFAULT_UNSANDBOXED_POLICY,
    prefix = "chub",
    operations = OPERATIONS,
  } = config;

  return {
    name: `context-hub:${prefix}`,

    attach: async (_agent: Agent): Promise<ReadonlyMap<string, unknown>> => {
      const toolEntries = operations.map((op) => {
        const factory = TOOL_FACTORIES[op];
        const tool = factory(executor, prefix, policy);
        const key: string = toolToken(tool.descriptor.name);
        return [key, tool] as const;
      });
      return new Map<string, unknown>([
        ...toolEntries,
        [skillToken(CONTEXT_HUB_SKILL_NAME) as string, CONTEXT_HUB_SKILL],
      ]);
    },
  };
}
