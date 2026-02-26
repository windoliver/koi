/**
 * @koi/dashboard-types — Shared types for the Koi web dashboard.
 *
 * L0u package: imports only from @koi/core.
 *
 * Provides:
 * - DashboardEvent discriminated unions (agent, skill, channel, system)
 * - DashboardDataSource adapter interface
 * - REST API response envelope (ApiResult<T>)
 * - DashboardConfig + defaults
 * - Cursor-based pagination types (Phase 3)
 */

// Config
export type { DashboardConfig } from "./config.js";
export { DEFAULT_DASHBOARD_CONFIG } from "./config.js";
// Cursors
export type { CursorPage, CursorRequest } from "./cursors.js";
// Data source
export type {
  DashboardAgentDetail,
  DashboardAgentSummary,
  DashboardChannelSummary,
  DashboardDataSource,
  DashboardSkillSummary,
  DashboardSystemMetrics,
} from "./data-source.js";
// Events
export type {
  AgentDashboardEvent,
  ChannelDashboardEvent,
  DashboardEvent,
  DashboardEventBatch,
  SkillDashboardEvent,
  SystemDashboardEvent,
} from "./events.js";
export {
  isAgentEvent,
  isChannelEvent,
  isDashboardEvent,
  isSkillEvent,
  isSystemEvent,
} from "./events.js";
// REST types
export type { ApiError, ApiResult } from "./rest-types.js";
