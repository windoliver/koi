/**
 * @koi/tui — Admin-panel-connected terminal console for operators.
 *
 * L2 package: depends on @koi/core, @koi/dashboard-client, @opentui/*.
 *
 * Usage:
 *   import { createTuiApp } from "@koi/tui";
 *   const tui = createTuiApp({ adminUrl: "http://localhost:3100" });
 *   await tui.start();
 */

// Re-export client types from @koi/dashboard-client for backward compat
export type {
  AdminClient,
  AdminClientConfig,
  AguiClientConfig,
  AguiEvent,
  AguiEventType,
  AguiStreamCallbacks,
  AguiStreamHandle,
  ChatHistoryMessage,
  ChatMessage,
  ChatRunInput,
  ClientResult,
  DashboardClientError,
  DebouncedFn,
  DispatchRequest,
  DispatchResponse,
  FsEntry,
  ReconnectCallbacks,
  ReconnectConfig,
  ReconnectHandle,
  ReconnectStatus,
  SessionInfo,
  SSEEvent,
  SSEFetcher,
  SSEStreamOptions,
} from "@koi/dashboard-client";
export {
  buildSessionPath,
  CHAT_SESSION_PREFIX,
  consumeSSEStream,
  createAdminClient,
  createDebounce,
  createReconnectingStream,
  ENGINE_SESSION_PREFIX,
  loadSavedSession,
  parseSessionRecord,
  parseTuiChatLog,
  SSEParser,
  startChatStream,
  TUI_SESSION_PREFIX,
} from "@koi/dashboard-client";

// State
export type { StateListener, TuiStore } from "./state/store.js";
export { createStore, reduce } from "./state/store.js";
export type {
  ConnectionStatus,
  SessionState,
  TuiAction,
  TuiError,
  TuiState,
  TuiView,
} from "./state/types.js";
export { createInitialState, MAX_SESSION_MESSAGES } from "./state/types.js";

// Theme
export {
  agentStateColor,
  COLORS,
  connectionStatusConfig,
} from "./theme.js";

// Views — command definitions
export type { PaletteCallbacks, PaletteCommand } from "./views/command-palette.js";
export { commandsToSelectItems, DEFAULT_COMMANDS } from "./views/command-palette.js";

// Views — status bar
export type { StatusBarData } from "./views/status-bar.js";
export {
  composeStatusBarText,
  formatAgentState,
  formatConnectionStatus,
} from "./views/status-bar.js";
// App
export type { TuiAppConfig, TuiAppHandle } from "./views/tui-app.js";
export { createTuiApp } from "./views/tui-app.js";
// Views — keyboard
export type { KeyboardCallbacks } from "./views/tui-keyboard.js";
export { createKeyboardHandler } from "./views/tui-keyboard.js";
// Views — session management
export {
  fetchRecentAgentActivity,
  persistCurrentSession,
  restoreSession,
} from "./views/tui-session.js";
