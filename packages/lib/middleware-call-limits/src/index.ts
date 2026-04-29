/**
 * @koi/middleware-call-limits — Per-session tool and model call caps.
 *
 * Two factories:
 *   - createToolCallLimitMiddleware — per-tool and global caps with continue/error exit
 *   - createModelCallLimitMiddleware — total model call cap with error exit
 *
 * Counters scoped to ctx.session.sessionId, atomic via incrementIfBelow.
 */

export type {
  ModelCallLimitConfig,
  ToolCallLimitConfig,
} from "./config.js";
export {
  validateModelCallLimitConfig,
  validateToolCallLimitConfig,
} from "./config.js";
export { createModelCallLimitMiddleware } from "./model-call-limit.js";
export { createInMemoryCallLimitStore } from "./store.js";
export { createToolCallLimitMiddleware } from "./tool-call-limit.js";
export type {
  CallLimitStore,
  IncrementIfBelowResult,
  LimitReachedInfo,
  ModelExitBehavior,
  ToolExitBehavior,
} from "./types.js";
