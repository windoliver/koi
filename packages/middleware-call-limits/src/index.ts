/**
 * @koi/middleware-call-limits — Model and tool call count enforcement.
 *
 * Provides two L2 middleware factories:
 * - createModelCallLimitMiddleware: caps model calls per session
 * - createToolCallLimitMiddleware: caps tool calls with per-tool and global limits
 */

export type { ModelCallLimitConfig, ToolCallLimitConfig } from "./config.js";
export { validateModelCallLimitConfig, validateToolCallLimitConfig } from "./config.js";
export { descriptor } from "./descriptor.js";
export { createModelCallLimitMiddleware } from "./model-call-limit.js";
export { createInMemoryCallLimitStore } from "./store.js";
export { createToolCallLimitMiddleware } from "./tool-call-limit.js";
export type {
  CallLimitStore,
  LimitReachedInfo,
  ModelExitBehavior,
  ToolExitBehavior,
} from "./types.js";
