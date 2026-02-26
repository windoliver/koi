/**
 * @koi/middleware-permissions — Tool-level access control + HITL approval (Layer 2)
 *
 * Checks allow/deny/ask permissions via pluggable PermissionBackend.
 * Supports human-in-the-loop approval for sensitive operations.
 * Depends on @koi/core only.
 */

// Re-export L0 types for convenience
export type {
  PermissionBackend,
  PermissionDecision,
  PermissionQuery,
} from "@koi/core/permission-backend";
export type { PermissionCacheConfig, PermissionsMiddlewareConfig } from "./config.js";
export {
  DEFAULT_APPROVAL_CACHE_MAX_ENTRIES,
  DEFAULT_APPROVAL_CACHE_TTL_MS,
  DEFAULT_CACHE_CONFIG,
  validatePermissionsConfig,
} from "./config.js";
export { descriptor } from "./descriptor.js";
export type { ApprovalHandler, PatternBackendConfig, PermissionRules } from "./engine.js";
export {
  createAutoApprovalHandler,
  createPatternPermissionBackend,
  DEFAULT_GROUPS,
} from "./engine.js";
export { createPermissionsMiddleware } from "./permissions.js";
