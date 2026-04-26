/**
 * Public API for TUI state management.
 *
 * Re-exports types, constants, reducer, store, and initial state factory.
 */

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
export type {
  AgentStatus,
  CapabilityFragmentLite,
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
  SecurityFinding,
  SessionInfo,
  SessionSummary,
  SpawnProgress,
  SpawnStats,
  SpawnStatus,
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
