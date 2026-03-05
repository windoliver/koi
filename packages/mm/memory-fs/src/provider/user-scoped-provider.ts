/**
 * User-scoped memory ComponentProvider.
 *
 * Reads `agent.pid.ownerId` to route each agent to a per-user FsMemory instance.
 * Falls back to a shared FsMemory when no userId is available (backward compat).
 */
import type { Agent, ComponentProvider, SkillComponent, Tool, ToolPolicy } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY, MEMORY, skillToken, toolToken } from "@koi/core";
import type { FsMemoryConfig } from "../types.js";
import { createUserScopedMemory, type UserScopedMemory } from "../user-scoped-memory.js";
import type { MemoryOperation } from "./constants.js";
import {
  DEFAULT_PREFIX,
  DEFAULT_RECALL_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  MEMORY_OPERATIONS,
} from "./constants.js";
import { generateMemorySkillContent } from "./skill.js";
import { createMemoryRecallTool } from "./tools/recall.js";
import { createMemorySearchTool } from "./tools/search.js";
import { createMemoryStoreTool } from "./tools/store.js";

export interface UserScopedMemoryProviderConfig {
  readonly baseDir: string;
  /** Maximum number of per-user FsMemory instances to cache. Default: 100. */
  readonly maxCachedUsers?: number | undefined;
  /** Config forwarded to each per-user FsMemory (baseDir is overridden per user). */
  readonly memoryConfig?: Partial<Omit<FsMemoryConfig, "baseDir">> | undefined;
  /** Tool name prefix. Default: "memory". */
  readonly prefix?: string | undefined;
  /** Trust tier for all tools. Default: "verified". */
  readonly policy?: ToolPolicy | undefined;
  /** Subset of operations to expose. Default: all 3. */
  readonly operations?: readonly MemoryOperation[] | undefined;
  /** Max results for recall tool. Default: 10. */
  readonly recallLimit?: number | undefined;
  /** Max results for search tool. Default: 20. */
  readonly searchLimit?: number | undefined;
}

export function createUserScopedMemoryProvider(
  config: UserScopedMemoryProviderConfig,
): ComponentProvider {
  const {
    baseDir,
    maxCachedUsers,
    memoryConfig = {},
    prefix = DEFAULT_PREFIX,
    policy = DEFAULT_UNSANDBOXED_POLICY,
    operations = MEMORY_OPERATIONS,
    recallLimit = DEFAULT_RECALL_LIMIT,
    searchLimit = DEFAULT_SEARCH_LIMIT,
  } = config;

  const scopedMemory: UserScopedMemory = createUserScopedMemory({
    baseDir,
    maxCachedUsers,
    memoryConfig,
  });

  return {
    name: "memory",

    attach: async (agent: Agent): Promise<ReadonlyMap<string, unknown>> => {
      const userId = agent.pid.ownerId;
      const memory =
        userId !== undefined && userId.length > 0
          ? await scopedMemory.getOrCreate(userId)
          : await scopedMemory.getShared();

      const skillContent = generateMemorySkillContent(baseDir);

      const toolFactories: Readonly<Record<MemoryOperation, () => Tool>> = {
        store: () => createMemoryStoreTool(memory.component, prefix, policy),
        recall: () => createMemoryRecallTool(memory.component, prefix, policy, recallLimit),
        search: () => createMemorySearchTool(memory, prefix, policy, searchLimit),
      };

      const toolEntries = operations.map((op) => {
        const tool = toolFactories[op]();
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

    detach: async (agent: Agent): Promise<void> => {
      const userId = agent.pid.ownerId;
      if (userId !== undefined && userId.length > 0) {
        // Rebuild summaries for this user's memory only
        const memory = await scopedMemory.getOrCreate(userId);
        await memory.rebuildSummaries();
        // Do NOT close — other sessions may share this cached instance
      } else {
        const shared = await scopedMemory.getShared();
        await shared.rebuildSummaries();
      }
    },
  };
}
