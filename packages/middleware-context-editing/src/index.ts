/**
 * @koi/middleware-context-editing — Retroactive tool result clearing (Layer 2)
 *
 * Scans message history before each model call and replaces old tool
 * result content with a placeholder when the total token count exceeds
 * a configurable threshold.
 * Depends on @koi/core only.
 */

export { createContextEditingMiddleware } from "./context-editing.js";
export { editMessages } from "./edit-messages.js";
export type { ContextEditingConfig, ResolvedContextEditingConfig } from "./types.js";
export { CONTEXT_EDITING_DEFAULTS } from "./types.js";
