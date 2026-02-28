/**
 * @koi/middleware-tool-audit — Tool usage tracking and lifecycle signals.
 *
 * Tracks per-tool call counts, latency, success/failure rates, and session
 * availability to emit lifecycle signals (unused, low adoption, high failure,
 * high value).
 */

export type { ToolAuditConfig } from "./config.js";
export { validateToolAuditConfig } from "./config.js";
export { descriptor } from "./descriptor.js";
export { computeLifecycleSignals } from "./signals.js";
export { createToolAuditMiddleware } from "./tool-audit.js";
export type {
  ToolAuditMiddleware,
  ToolAuditResult,
  ToolAuditSnapshot,
  ToolAuditStore,
  ToolLifecycleSignal,
  ToolUsageRecord,
} from "./types.js";
