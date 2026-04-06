/**
 * @koi/memory-tools — Memory tool surfaces for LLM agent execution.
 *
 * Provides 4 memory tools (store, recall, search, delete) that the model
 * calls to interact with the memory system during agent execution.
 */

// Constants
export {
  DEFAULT_PREFIX,
  DEFAULT_RECALL_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  MEMORY_OPERATIONS,
  validateMemoryDir,
} from "./constants.js";
// Provider
export { createMemoryToolProvider } from "./provider.js";
// Skill
export type { MemorySkillOptions } from "./skill.js";
export { generateMemoryToolSkillContent, MEMORY_TOOL_SKILL_CONTENT } from "./skill.js";
// Tool factories
export { createMemoryDeleteTool } from "./tools/memory-delete.js";
export { createMemoryRecallTool } from "./tools/memory-recall.js";
export { createMemorySearchTool } from "./tools/memory-search.js";
export { createMemoryStoreTool } from "./tools/memory-store.js";
// Types
export type {
  DeleteResult,
  MemorySearchFilter,
  MemoryToolBackend,
  MemoryToolProviderConfig,
  MemoryToolRecallOptions,
  StoreWithDedupOptions,
  StoreWithDedupResult,
} from "./types.js";
