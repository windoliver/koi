/**
 * @koi/middleware-tool-selector — Pre-filter tools before model calls.
 *
 * Reduces the set of tools sent to the LLM on each turn using a pluggable
 * selection strategy. Two built-in strategies ship with the package
 * (`createKeywordSelectTools`, `createTagSelectTools`); callers can also
 * supply their own `selectTools` function.
 */

export type { ToolSelectorConfig } from "./config.js";
export { DEFAULT_MAX_TOOLS, DEFAULT_MIN_TOOLS, validateToolSelectorConfig } from "./config.js";
export { extractLastUserText } from "./extract-query.js";
export type { SelectToolsFn } from "./select-strategy.js";
export { createKeywordSelectTools, createTagSelectTools } from "./select-strategy.js";
export { createToolSelectorMiddleware } from "./tool-selector.js";
