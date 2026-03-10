/**
 * @koi/dashboard-types — Shared types for the Koi web dashboard.
 *
 * L0u package: imports only from @koi/core.
 *
 * Provides:
 * - DashboardEvent discriminated unions (agent, skill, channel, system, nexus, gateway)
 * - DashboardDataSource adapter interface
 * - RuntimeViewDataSource for computed state views
 * - CommandDispatcher for imperative operations
 * - AdminPanelConfig + SavedViewDefinition
 * - REST API response envelope (ApiResult<T>)
 * - DashboardConfig + defaults
 * - Cursor-based pagination types (Phase 3)
 */

// Admin panel
export type {
  AdminPanelConfig,
  AdminPanelDataSources,
  SavedViewDefinition,
} from "./admin-panel.js";
export { SAVED_VIEWS } from "./admin-panel.js";
// Commands
export type { AgentMessage, CommandDispatcher } from "./commands.js";
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
  GatewayDashboardEvent,
  NexusDashboardEvent,
  SkillDashboardEvent,
  SystemDashboardEvent,
} from "./events.js";
export {
  isAgentEvent,
  isChannelEvent,
  isDashboardEvent,
  isGatewayEvent,
  isNexusEvent,
  isSkillEvent,
  isSystemEvent,
} from "./events.js";
// REST types
export type { ApiError, ApiResult } from "./rest-types.js";
// Runtime views
export type {
  AgentProcfs,
  GatewayConnection,
  GatewayTopology,
  MiddlewareChain,
  MiddlewareEntry,
  ProcessTreeNode,
  ProcessTreeSnapshot,
  RuntimeViewDataSource,
} from "./runtime-views.js";
