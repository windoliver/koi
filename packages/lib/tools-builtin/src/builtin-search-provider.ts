import type { ComponentProvider, JsonObject, ToolPolicy, ToolSummary } from "@koi/core";
import { COMPONENT_PRIORITY, DEFAULT_UNSANDBOXED_POLICY, toolToken } from "@koi/core";
import type { BuiltinSearchOperation } from "./constants.js";
import { BUILTIN_SEARCH_OPERATIONS } from "./constants.js";
import { createGlobTool } from "./glob-tool.js";
import { createGrepTool } from "./grep-tool.js";
import { createToolSearchTool } from "./tool-search-tool.js";

export interface BuiltinSearchProviderConfig {
  readonly cwd: string;
  readonly getTools?: () => readonly ToolSummary[];
  readonly policy?: ToolPolicy;
  readonly operations?: readonly BuiltinSearchOperation[];
}

export function createBuiltinSearchProvider(
  config: BuiltinSearchProviderConfig,
): ComponentProvider {
  const {
    cwd,
    getTools = () => [],
    policy = DEFAULT_UNSANDBOXED_POLICY,
    operations = BUILTIN_SEARCH_OPERATIONS,
  } = config;

  const factories: Record<BuiltinSearchOperation, () => JsonObject> = {
    Glob: () => createGlobTool({ cwd, policy }) as unknown as JsonObject,
    Grep: () => createGrepTool({ cwd, policy }) as unknown as JsonObject,
    ToolSearch: () => createToolSearchTool({ getTools, policy }) as unknown as JsonObject,
  };

  return {
    name: "builtin-search",
    priority: COMPONENT_PRIORITY.BUNDLED,
    attach: async (): Promise<ReadonlyMap<string, unknown>> => {
      const entries: [string, unknown][] = [];
      for (const op of operations) {
        const factory = factories[op];
        entries.push([toolToken(op), factory()]);
      }
      return new Map(entries);
    },
  };
}
