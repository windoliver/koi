/**
 * @koi/middleware-permissions — Tool-level access control + HITL approval (Layer 2)
 *
 * Checks allow/deny/ask patterns before tool execution.
 * Supports human-in-the-loop approval for sensitive operations.
 * Depends on @koi/core only.
 */

export type { ApprovalCacheConfig, PermissionsMiddlewareConfig } from "./config.js";
export { DEFAULT_APPROVAL_CACHE_MAX_ENTRIES, validateConfig } from "./config.js";
export type {
  ApprovalHandler,
  PermissionDecision,
  PermissionEngine,
  PermissionRules,
} from "./engine.js";
export {
  createAutoApprovalHandler,
  createPatternPermissionEngine,
} from "./engine.js";
export { createPermissionsMiddleware } from "./permissions.js";
