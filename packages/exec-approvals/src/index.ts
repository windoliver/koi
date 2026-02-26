/**
 * @koi/exec-approvals — Progressive command allowlisting middleware (Layer 2)
 *
 * Intercepts tool calls with allow/deny/ask patterns. Users make runtime
 * approval decisions (allow-once, allow-session, allow-always, deny-once,
 * deny-always) that accumulate progressively across the session.
 *
 * Depends on @koi/core and @koi/errors only.
 */

export type { ExecApprovalsConfig } from "./config.js";
export { DEFAULT_APPROVAL_TIMEOUT_MS, validateExecApprovalsConfig } from "./config.js";
export { createExecApprovalsMiddleware } from "./middleware.js";
// defaultExtractCommand exported for callers who want to extend it
export { defaultExtractCommand } from "./pattern.js";
export { createInMemoryRulesStore } from "./store.js";
export type {
  ExecApprovalRequest,
  ExecRulesStore,
  PersistedRules,
  ProgressiveDecision,
} from "./types.js";
