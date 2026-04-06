/**
 * createMemoryToolProvider — ComponentProvider that attaches all 4 memory tools.
 *
 * Builds memory_store, memory_recall, memory_search, and memory_delete tools
 * from a MemoryToolBackend, then wraps them in a ComponentProvider for agent
 * assembly.
 */

import type { ComponentProvider, KoiError, Result, Tool } from "@koi/core";
import { COMPONENT_PRIORITY } from "@koi/core";
import { createToolComponentProvider } from "@koi/tools-core";
import {
  DEFAULT_PREFIX,
  DEFAULT_RECALL_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  validateMemoryDir,
} from "./constants.js";
import { createMemoryDeleteTool } from "./tools/memory-delete.js";
import { createMemoryRecallTool } from "./tools/memory-recall.js";
import { createMemorySearchTool } from "./tools/memory-search.js";
import { createMemoryStoreTool } from "./tools/memory-store.js";
import type { MemoryToolProviderConfig } from "./types.js";

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

  const provider = createToolComponentProvider({
    name: `${prefix}-tools`,
    tools,
    priority,
  });

  return { ok: true, value: provider };
}
