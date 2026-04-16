/**
 * createMemoryToolProvider — ComponentProvider that attaches all 4 memory tools.
 *
 * Builds memory_store, memory_recall, memory_search, and memory_delete tools
 * from a MemoryToolBackend, then wraps them in a ComponentProvider for agent
 * assembly.
 */

import type { ComponentProvider, KoiError, Result, SkillComponent, Tool } from "@koi/core";
import { COMPONENT_PRIORITY, isAttachResult, skillToken } from "@koi/core";
import { createToolComponentProvider } from "@koi/tools-core";
import {
  DEFAULT_PREFIX,
  DEFAULT_RECALL_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  validateMemoryDir,
} from "./constants.js";
import { generateMemoryToolSkillContent } from "./skill.js";
import { createMemoryDeleteTool } from "./tools/memory-delete.js";
import { createMemoryRecallTool } from "./tools/memory-recall.js";
import { createMemorySearchTool } from "./tools/memory-search.js";
import { createMemoryStoreTool } from "./tools/memory-store.js";
import type { MemoryToolProviderConfig } from "./types.js";

/** Skill component name for memory tool behavioral guidance. */
const MEMORY_SKILL_NAME = "memory" as const;

/**
 * Create a ComponentProvider that attaches all 4 memory tools to agents.
 *
 * Returns `Result<ComponentProvider, KoiError>` — fails if any tool fails
 * to build (e.g. invalid definition or invalid memoryDir).
 */
export function createMemoryToolProvider(
  config: MemoryToolProviderConfig,
): Result<ComponentProvider, KoiError> {
  const {
    backend,
    memoryDir,
    prefix = DEFAULT_PREFIX,
    recallLimit = DEFAULT_RECALL_LIMIT,
    searchLimit = DEFAULT_SEARCH_LIMIT,
    priority = COMPONENT_PRIORITY.BUNDLED,
  } = config;

  const dirValidation = validateMemoryDir(memoryDir);
  if (!dirValidation.ok) return dirValidation;

  const results: readonly Result<Tool, KoiError>[] = [
    createMemoryStoreTool(backend, memoryDir, prefix),
    createMemoryRecallTool(backend, memoryDir, prefix, recallLimit),
    createMemorySearchTool(backend, memoryDir, prefix, searchLimit),
    createMemoryDeleteTool(backend, memoryDir, prefix),
  ];

  const firstError = results.find((r) => !r.ok);
  if (firstError !== undefined && !firstError.ok) return firstError;

  const tools: readonly Tool[] = results.flatMap((r) => (r.ok ? [r.value] : []));

  const inner = createToolComponentProvider({
    name: `${prefix}-tools`,
    tools,
    priority,
  });

  const skill: SkillComponent = {
    name: MEMORY_SKILL_NAME,
    description:
      "When and how to use memory tools — storage types, recall strategy, decay tiers, and best practices",
    content: generateMemoryToolSkillContent({ prefix, baseDir: memoryDir }),
    tags: ["memory", "best-practices"],
  };

  const provider: ComponentProvider = {
    name: inner.name,
    ...(inner.priority !== undefined ? { priority: inner.priority } : {}),
    async attach(agent) {
      const result = await inner.attach(agent);
      const components = isAttachResult(result) ? result.components : result;
      const merged = new Map(components);
      merged.set(skillToken(MEMORY_SKILL_NAME) as string, skill);
      const skipped = isAttachResult(result) ? result.skipped : [];
      return { components: merged, skipped };
    },
  };

  return { ok: true, value: provider };
}
