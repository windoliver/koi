/**
 * Memory ComponentProvider — attaches memory Tool + Skill components to an agent.
 *
 * Wraps an FsMemory instance into tools for store/recall/search, plus a skill
 * with behavioral instructions. Unlike scheduler-provider, no per-agent wrapping
 * is needed — each FsMemory is already agent-scoped (one baseDir per agent).
 */

import type { Agent, ComponentProvider, SkillComponent, Tool, ToolPolicy } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY, MEMORY, skillToken, toolToken } from "@koi/core";
import type { FsMemory } from "../types.js";
import type { MemoryOperation } from "./constants.js";
import {
  DEFAULT_PREFIX,
  DEFAULT_RECALL_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  MEMORY_OPERATIONS,
} from "./constants.js";
import { generateMemorySkillContent, MEMORY_SKILL_CONTENT } from "./skill.js";
import { createMemoryRecallTool } from "./tools/recall.js";
import { createMemorySearchTool } from "./tools/search.js";
import { createMemoryStoreTool } from "./tools/store.js";

export interface MemoryProviderConfig {
  readonly memory: FsMemory;
  /** On-disk base directory. Included in skill content so the agent knows where memory lives. */
  readonly baseDir?: string;
  /** Tool name prefix. Default: "memory". */
  readonly prefix?: string;
  /** Trust tier for all tools. Default: "verified". */
  readonly policy?: ToolPolicy;
  /** Subset of operations to expose. Default: all 3. */
  readonly operations?: readonly MemoryOperation[];
  /** Max results for recall tool. Default: 10. */
  readonly recallLimit?: number;
  /** Max results for search tool. Default: 20. */
  readonly searchLimit?: number;
  /** Override skill content. Default: auto-generated with baseDir. */
  readonly skillContent?: string;
}

type ToolFactory = (
  memory: FsMemory,
  prefix: string,
  policy: ToolPolicy,
  recallLimit: number,
  searchLimit: number,
) => Tool;

const TOOL_FACTORIES: Readonly<Record<MemoryOperation, ToolFactory>> = {
  store: (m, p, t) => createMemoryStoreTool(m.component, p, t),
  recall: (m, p, t, rl) => createMemoryRecallTool(m.component, p, t, rl),
  search: (m, p, t, _rl, sl) => createMemorySearchTool(m, p, t, sl),
};

export function createMemoryProvider(config: MemoryProviderConfig): ComponentProvider {
  const {
    memory,
    baseDir,
    policy = DEFAULT_UNSANDBOXED_POLICY,
    prefix = DEFAULT_PREFIX,
    operations = MEMORY_OPERATIONS,
    recallLimit = DEFAULT_RECALL_LIMIT,
    searchLimit = DEFAULT_SEARCH_LIMIT,
    skillContent = baseDir !== undefined
      ? generateMemorySkillContent(baseDir)
      : MEMORY_SKILL_CONTENT,
  } = config;

  return {
    name: "memory",

    attach: async (_agent: Agent): Promise<ReadonlyMap<string, unknown>> => {
      const toolEntries = operations.map((op) => {
        const factory = TOOL_FACTORIES[op];
        const tool = factory(memory, prefix, policy, recallLimit, searchLimit);
        return [toolToken(tool.descriptor.name) as string, tool] as const;
      });

      const skill: SkillComponent = {
        name: "memory",
        description: "Long-term memory management for the agent",
        content: skillContent,
      };

      return new Map<string, unknown>([
        [MEMORY as string, memory.component],
        ...toolEntries,
        [skillToken("memory") as string, skill],
      ]);
    },

    detach: async (_agent: Agent): Promise<void> => {
      await memory.rebuildSummaries();
      await memory.close();
    },
  };
}
