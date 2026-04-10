/**
 * @koi/middleware-permissions — Tool-level access control middleware.
 *
 * Pattern-based permission classifier with human-in-the-loop approval,
 * decision caching, denial tracking, audit logging, and circuit breaker resilience.
 */

// L0 re-exports for convenience
export type {
  PermissionBackend,
  PermissionDecision,
  PermissionQuery,
} from "@koi/core/permission-backend";
// Persistent approval store
export type { ApprovalGrant, ApprovalStore, ApprovalStoreConfig } from "./approval-store.js";
export { createApprovalStore } from "./approval-store.js";
// Classifier (pattern backend)
export type { PatternBackendConfig, PermissionRules } from "./classifier.js";
export {
  createAutoApprovalHandler,
  createPatternPermissionBackend,
  DEFAULT_DENY_MARKER,
  DEFAULT_GROUPS,
  isDefaultDeny,
} from "./classifier.js";
// Config
export type {
  ApprovalCacheConfig,
  DenialEscalationConfig,
  PermissionCacheConfig,
  PermissionsMiddlewareConfig,
} from "./config.js";
export {
  DEFAULT_APPROVAL_CACHE_MAX_ENTRIES,
  DEFAULT_APPROVAL_CACHE_TTL_MS,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  DEFAULT_CACHE_CONFIG,
  DEFAULT_DENIAL_ESCALATION_THRESHOLD,
  DEFAULT_DENIAL_ESCALATION_WINDOW_MS,
  validatePermissionsConfig,
} from "./config.js";
// Denial tracking
export type { DenialRecord, DenialSource, DenialTracker } from "./denial-tracker.js";
export { createDenialTracker } from "./denial-tracker.js";

// Middleware factory
export type { PermissionsMiddlewareHandle } from "./middleware.js";
export { createPermissionsMiddleware } from "./middleware.js";
