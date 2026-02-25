/**
 * @koi/middleware-tool-selector — Pre-filter tools before model calls (Layer 2)
 *
 * Uses a caller-provided selector function to reduce the set of tools
 * sent to the model, saving tokens and improving selection accuracy.
 * Depends on @koi/core only.
 */

export type { ToolSelectorConfig } from "./config.js";
export { validateToolSelectorConfig } from "./config.js";
export { extractLastUserText } from "./extract-query.js";
export { createToolSelectorMiddleware } from "./tool-selector.js";
