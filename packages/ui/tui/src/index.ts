/**
 * @koi/tui — Admin-panel-connected terminal console for operators.
 *
 * L2 package: depends on @koi/core, @koi/dashboard-types, pi-tui.
 *
 * Usage:
 *   import { createTui } from "@koi/tui";
 *   const tui = createTui({ adminUrl: "http://localhost:3100" });
 *   await tui.start();
 */

// Client — Admin API
export type {
  AdminClient,
  AdminClientConfig,
  ClientResult,
  DispatchRequest,
  DispatchResponse,
  FsEntry,
} from "./client/admin-client.js";
export { createAdminClient } from "./client/admin-client.js";
// Client — AG-UI Chat
export type {
  AguiClientConfig,
  AguiEvent,
  AguiEventType,
  AguiStreamCallbacks,
  AguiStreamHandle,
  ChatHistoryMessage,
  ChatRunInput,
} from "./client/agui-client.js";
export { startChatStream } from "./client/agui-client.js";
// Client — Reconnection
export type {
  ReconnectCallbacks,
  ReconnectConfig,
  ReconnectHandle,
  ReconnectStatus,
  SSEFetcher,
} from "./client/reconnect.js";
export { createReconnectingStream } from "./client/reconnect.js";
// Client — SSE
export type { SSEEvent, SSEStreamOptions } from "./client/sse-stream.js";
export { consumeSSEStream, SSEParser } from "./client/sse-stream.js";
export type { StateListener, TuiStore } from "./state/store.js";
export { createStore, reduce } from "./state/store.js";
// State
export type {
  ChatMessage,
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
  KOI_MARKDOWN_THEME,
  KOI_SELECT_THEME,
  styleAgentState,
  styleConnectionStatus,
  styleDim,
  styleError,
  styleHeader,
  styleHr,
  styleStatusLabel,
  styleStatusValue,
  styleSuccess,
  styleWarning,
} from "./theme.js";
export type { AgentListCallbacks } from "./views/agent-list-view.js";
export { createAgentListView } from "./views/agent-list-view.js";
export type { PaletteCallbacks, PaletteCommand } from "./views/command-palette.js";
export { createCommandPalette, DEFAULT_COMMANDS } from "./views/command-palette.js";
export type { ConsoleCallbacks } from "./views/console-view.js";
export { createConsoleView } from "./views/console-view.js";
export type { SessionPickerDeps, SessionPickerHandle } from "./views/session-picker.js";
export { createSessionPicker, parseSessionMessages } from "./views/session-picker.js";
// Views
export type { StatusBarData } from "./views/status-bar.js";
export { createStatusBar } from "./views/status-bar.js";

// App
export type { TuiAppConfig, TuiAppHandle } from "./views/tui-app.js";
export { createTuiApp } from "./views/tui-app.js";
