/**
 * @koi/middleware-permissions — Tool-level access control + HITL approval (Layer 2)
 *
 * Checks allow/deny/ask patterns before tool execution.
 * Supports human-in-the-loop approval for sensitive operations.
 * Depends on @koi/core only.
 */

export type { ApprovalCacheConfig, PermissionsMiddlewareConfig } from "./config.js";
export {
  DEFAULT_APPROVAL_CACHE_MAX_ENTRIES,
  DEFAULT_APPROVAL_CACHE_TTL_MS,
  validatePermissionsConfig,
} from "./config.js";
export { descriptor } from "./descriptor.js";
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
