/**
 * Web ComponentProvider — attaches web Tool components to an agent.
 *
 * Engines discover tools via `agent.query<Tool>("tool:")`.
 * This provider creates Tool components from a WebExecutor, making them
 * available to any engine with zero engine changes.
 */

import type { Agent, ComponentProvider, Tool, TrustTier } from "@koi/core";
import { toolToken } from "@koi/core";
import { OPERATIONS, type WebOperation } from "./constants.js";
import { createWebFetchTool } from "./tools/web-fetch.js";
import { createWebSearchTool } from "./tools/web-search.js";
import type { WebExecutor } from "./web-executor.js";

export interface WebProviderConfig {
  readonly executor: WebExecutor;
  /** Default trust tier for all operations (default: "verified"). */
  readonly trustTier?: TrustTier | undefined;
  /** Tool name prefix (default: "web"). */
  readonly prefix?: string | undefined;
  /** Operations to include (default: all). */
  readonly operations?: readonly WebOperation[] | undefined;
}

type ToolFactory = (executor: WebExecutor, prefix: string, trustTier: TrustTier) => Tool;

const TOOL_FACTORIES: Readonly<Record<WebOperation, ToolFactory>> = {
  fetch: createWebFetchTool,
  search: createWebSearchTool,
};

export function createWebProvider(config: WebProviderConfig): ComponentProvider {
  const { executor, trustTier = "verified", prefix = "web", operations = OPERATIONS } = config;

  return {
    name: `web:${prefix}`,

    attach: async (_agent: Agent): Promise<ReadonlyMap<string, unknown>> => {
      const entries: ReadonlyMap<string, unknown> = new Map(
        operations.map((op) => {
          const factory = TOOL_FACTORIES[op];
          const tool = factory(executor, prefix, trustTier);
          const key: string = toolToken(tool.descriptor.name);
          return [key, tool] as const;
        }),
      );
      return entries;
    },
  };
}
