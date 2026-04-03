/**
 * Public API for TUI state management.
 *
 * Re-exports types, constants, reducer, store, and initial state factory.
 */

// Initial state
export { createInitialState } from "./initial.js";
// Reducer
export { reduce } from "./reduce.js";
// Store
export type { StateListener, TuiStore } from "./store.js";
export { createStore } from "./store.js";
// Types & constants
export type {
  ConnectionStatus,
  LayoutTier,
  PermissionPromptData,
  PermissionRiskLevel,
  ToolCallStatus,
  TuiAction,
  TuiAssistantBlock,
  TuiMessage,
  TuiModal,
  TuiState,
  TuiView,
} from "./types.js";
export { COMPACT_THRESHOLD, MAX_MESSAGES, MAX_TOOL_OUTPUT_CHARS } from "./types.js";
