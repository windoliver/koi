/**
 * createMemoryToolProvider — ComponentProvider that attaches all 4 memory tools.
 *
 * Builds memory_store, memory_recall, memory_search, and memory_delete tools
 * from a MemoryToolBackend, then wraps them in a ComponentProvider for agent
 * assembly.
 */

import type { ComponentProvider, KoiError, Result, Tool } from "@koi/core";
import { COMPONENT_PRIORITY, DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { createToolComponentProvider } from "@koi/tools-core";
import { DEFAULT_PREFIX, DEFAULT_RECALL_LIMIT, DEFAULT_SEARCH_LIMIT } from "./constants.js";
import { createMemoryDeleteTool } from "./tools/memory-delete.js";
import { createMemoryRecallTool } from "./tools/memory-recall.js";
import { createMemorySearchTool } from "./tools/memory-search.js";
import { createMemoryStoreTool } from "./tools/memory-store.js";
import type { MemoryToolProviderConfig } from "./types.js";

/**
 * Create a ComponentProvider that attaches all 4 memory tools to agents.
 *
 * Returns `Result<ComponentProvider, KoiError>` — fails if any tool fails
 * to build (e.g. invalid definition).
 */
export function createMemoryToolProvider(
  config: MemoryToolProviderConfig,
): Result<ComponentProvider, KoiError> {
  const {
    backend,
    prefix = DEFAULT_PREFIX,
    recallLimit = DEFAULT_RECALL_LIMIT,
    searchLimit = DEFAULT_SEARCH_LIMIT,
    policy = DEFAULT_UNSANDBOXED_POLICY,
    priority = COMPONENT_PRIORITY.BUNDLED,
  } = config;

  const results: readonly Result<Tool, KoiError>[] = [
    createMemoryStoreTool(backend, prefix, policy),
    createMemoryRecallTool(backend, prefix, policy, recallLimit),
    createMemorySearchTool(backend, prefix, policy, searchLimit),
    createMemoryDeleteTool(backend, prefix, policy),
  ];

  const tools: Tool[] = [];
  for (const result of results) {
    if (!result.ok) return result;
    tools.push(result.value);
  }

  const provider = createToolComponentProvider({
    name: `${prefix}-tools`,
    tools,
    priority,
  });

  return { ok: true, value: provider };
}
