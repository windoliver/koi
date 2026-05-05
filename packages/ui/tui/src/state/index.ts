/**
 * Public API for TUI state management.
 *
 * Re-exports types, constants, reducer, store, and initial state factory.
 */

// Freshness pure function
export type { FreshnessInput } from "./freshness.js";
export { computeFreshness } from "./freshness.js";
// Initial state
export { createInitialState } from "./initial.js";
// Mutations (SolidJS store backend)
export { mutate } from "./mutations.js";
// Reducer
export { reduce } from "./reduce.js";
// Store
export type { StateListener, TuiStore } from "./store.js";
export { createStore } from "./store.js";
// Types & constants
// Supervisor / background session types (not included in main type bundle above)
export type {
  AgentStatus,
  BgSessionRow,
  BgSessionsSlice,
  BridgeStatus,
  CapabilityFragmentLite,
  ChannelLiveness,
  ConnectionStatus,
  CumulativeMetrics,
  FetchModelsResult,
  GovernanceAlert,
  GovernanceSlice,
  GovernanceViolation,
  LayoutTier,
  LedgerAuditEntry,
  LedgerSources,
  McpServerInfo,
  ModelEntry,
  PermissionPromptData,
  PermissionRiskLevel,
  PlanTask,
  RegistryStatus,
  SecurityFinding,
  SessionInfo,
  SessionSummary,
  SpawnProgress,
  SpawnStats,
  SpawnStatus,
  SupervisorEventEntry,
  SupervisorSlice,
  Toast,
  ToastKind,
  ToolCallStatus,
  ToolResultData,
  TrajectoryMiddlewareSpan,
  TrajectoryStepSummary,
  TrajectoryTokenMetrics,
  TuiAction,
  TuiAssistantBlock,
  TuiMessage,
  TuiModal,
  TuiState,
  TuiView,
} from "./types.js";
export { COMPACT_THRESHOLD, MAX_MESSAGES, MAX_SESSIONS, MAX_TOOL_RESULT_BYTES } from "./types.js";
