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
// AG-UI protocol
export type {
  AguiEvent,
  AguiEventType,
  ChatHistoryMessage,
  ChatRunInput,
} from "./agui.js";
export { parseAguiEvent } from "./agui.js";
// Commands
export type {
  AgentMessage,
  CommandDispatcher,
  DelegationSummary,
  DispatchAgentRequest,
  DispatchAgentResponse,
  GovernancePendingItem,
  HandoffSummary,
  ScratchpadEntryDetail,
  ScratchpadEntrySummary,
} from "./commands.js";
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
  DashboardSchemaColumn,
  DashboardSchemaTable,
  DashboardSkillSummary,
  DashboardSystemMetrics,
  DashboardVerificationStage,
  DataSourceDetail,
  DataSourceFitnessSummary,
  DataSourceSummary,
} from "./data-source.js";
// Events
export type {
  AgentDashboardEvent,
  ChannelDashboardEvent,
  DashboardEvent,
  DashboardEventBatch,
  DataSourceDashboardEvent,
  ForgeDashboardEvent,
  GatewayDashboardEvent,
  HarnessDashboardEvent,
  MonitorDashboardEvent,
  NexusDashboardEvent,
  PtyOutputDashboardEvent,
  SchedulerDashboardEvent,
  SkillDashboardEvent,
  SystemDashboardEvent,
  TaskBoardDashboardEvent,
  TemporalDashboardEvent,
} from "./events.js";
export {
  isAgentEvent,
  isChannelEvent,
  isDashboardEvent,
  isDataSourceEvent,
  isForgeEvent,
  isGatewayEvent,
  isHarnessEvent,
  isMonitorEvent,
  isNexusEvent,
  isPtyOutputEvent,
  isSchedulerEvent,
  isSkillEvent,
  isSystemEvent,
  isTaskBoardEvent,
  isTemporalEvent,
} from "./events.js";
// REST types
export type { ApiError, ApiResult } from "./rest-types.js";
// Routes
export type { AdminRoutes, HttpMethod, RouteDefinition } from "./routes.js";
export { ADMIN_ROUTES, interpolatePath } from "./routes.js";
// Runtime views
export type {
  AgentProcfs,
  CheckpointEntry,
  CronSchedule,
  ForgeBrickView,
  ForgeStats,
  GatewayConnection,
  GatewayTopology,
  HarnessStatus,
  MiddlewareChain,
  MiddlewareEntry,
  ProcessTreeNode,
  ProcessTreeSnapshot,
  RuntimeViewDataSource,
  SchedulerDeadLetterEntry,
  SchedulerStats,
  SchedulerTaskSummary,
  TaskBoardEdge,
  TaskBoardNode,
  TaskBoardSnapshot,
  TemporalHealth,
  TimelineEvent,
  WorkflowDetail,
  WorkflowSummary,
} from "./runtime-views.js";
// SSE parser
export type { SSEEvent, SSEStreamOptions } from "./sse-parser.js";
export { consumeSSEStream, SSEParser } from "./sse-parser.js";
