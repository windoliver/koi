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
// Components — split pane
export type { AgentPaneData, AgentSplitPaneProps } from "./components/agent-split-pane.js";
export { AgentSplitPane } from "./components/agent-split-pane.js";
// Components
export type { PanelChromeProps } from "./components/panel-chrome.js";
export { PanelChrome } from "./components/panel-chrome.js";
// Lib — first-run tooltips
export type { TooltipId, TuiPersistentState } from "./lib/first-run.js";
export {
  dismissTooltip,
  loadTuiState,
  recordSessionStart,
  saveTuiState,
  shouldShowTooltip,
} from "./lib/first-run.js";
// Lib — terminal emulation
export type { TerminalConfig, TerminalInstance } from "./lib/ghostty-wasm.js";
export { createTerminal } from "./lib/ghostty-wasm.js";
// State — domain types
export type {
  AgentProcfsViewState,
  ChannelsViewState,
  CostViewState,
  DelegationViewState,
  GatewayViewState,
  GovernancePendingApproval,
  GovernanceViewState,
  GovernanceViolation,
  HandoffViewState,
  HarnessViewState,
  MailboxViewState,
  MiddlewareViewState,
  NexusBrowserState,
  NexusViewState,
  ProcessTreeViewState,
  SchedulerViewState,
  ScratchpadViewState,
  SkillsViewState,
  SystemViewState,
  TaskBoardViewState,
  TemporalViewState,
  TuiCapabilities,
} from "./state/domain-types.js";
// State
export type { StateListener, TuiStore } from "./state/store.js";
export { createStore, reduce } from "./state/store.js";
export type {
  ConnectionStatus,
  PresetInfo,
  SessionPickerEntry,
  SessionState,
  TuiAction,
  TuiError,
  TuiMode,
  TuiState,
  TuiView,
  ZoomLevel,
} from "./state/types.js";
export { createInitialState, MAX_SESSION_MESSAGES } from "./state/types.js";
// Theme
export {
  agentStateColor,
  COLORS,
  connectionStatusConfig,
} from "./theme.js";
// Views — add-on picker
export type { AddonOption, AddonPickerViewProps } from "./views/addon-picker-view.js";
export { AddonPickerView, AVAILABLE_ADDONS } from "./views/addon-picker-view.js";
// Views — OpenTUI components
export type { AgentListViewProps } from "./views/agent-list-view.js";
export { AgentListView } from "./views/agent-list-view.js";
export type { AgentProcfsViewProps } from "./views/agent-procfs-view.js";
export { AgentProcfsView } from "./views/agent-procfs-view.js";
export type { ChannelsViewProps } from "./views/channels-view.js";
export { ChannelsView } from "./views/channels-view.js";
export type { PaletteCallbacks, PaletteCommand } from "./views/command-palette.js";
export { commandsToSelectItems, DEFAULT_COMMANDS } from "./views/command-palette.js";
export type { CommandPaletteViewProps } from "./views/command-palette-view.js";
export { CommandPaletteView } from "./views/command-palette-view.js";
export type { ConsoleViewProps } from "./views/console-view.js";
export { ConsoleView } from "./views/console-view.js";
export type { CostViewProps } from "./views/cost-view.js";
export { CostView } from "./views/cost-view.js";
export type { DelegationViewProps } from "./views/delegation-view.js";
export { DelegationView } from "./views/delegation-view.js";
export type { GatewayViewProps } from "./views/gateway-view.js";
export { GatewayView } from "./views/gateway-view.js";
export type { GovernanceViewProps } from "./views/governance-view.js";
export { GovernanceView } from "./views/governance-view.js";
export type { HandoffViewProps } from "./views/handoff-view.js";
export { HandoffView } from "./views/handoff-view.js";
export type { HarnessViewProps } from "./views/harness-view.js";
export { HarnessView } from "./views/harness-view.js";
export type { MailboxViewProps } from "./views/mailbox-view.js";
export { MailboxView } from "./views/mailbox-view.js";
export type { MessageRowProps } from "./views/message-row.js";
export { MessageRow } from "./views/message-row.js";
export type { MiddlewareViewProps } from "./views/middleware-view.js";
export { MiddlewareView } from "./views/middleware-view.js";
export type { NexusBrowserViewProps } from "./views/nexus-browser-view.js";
export { NexusBrowserView } from "./views/nexus-browser-view.js";
export type { NexusViewProps } from "./views/nexus-view.js";
export { NexusView } from "./views/nexus-view.js";
export type { ProcessTreeViewProps } from "./views/process-tree-view.js";
export { ProcessTreeView } from "./views/process-tree-view.js";
export type { SchedulerViewProps } from "./views/scheduler-view.js";
export { SchedulerView } from "./views/scheduler-view.js";
export type { ScratchpadViewProps } from "./views/scratchpad-view.js";
export { ScratchpadView } from "./views/scratchpad-view.js";
export type { SessionPickerViewProps } from "./views/session-picker-view.js";
export { SessionPickerView } from "./views/session-picker-view.js";
// Views — new domain views
export type { SkillsViewProps } from "./views/skills-view.js";
export { SkillsView } from "./views/skills-view.js";
// Views — status bar
export type { StatusBarData } from "./views/status-bar.js";
export {
  composeStatusBarText,
  formatAgentState,
  formatConnectionStatus,
} from "./views/status-bar.js";
export type { StatusBarViewProps } from "./views/status-bar-view.js";
export { StatusBarView } from "./views/status-bar-view.js";
export { useDerivedState, useStoreState } from "./views/store-bridge.js";
export type { SystemViewProps } from "./views/system-view.js";
export { SystemView } from "./views/system-view.js";
export type { TaskBoardViewProps } from "./views/taskboard-view.js";
export { TaskBoardView } from "./views/taskboard-view.js";
export type { TemporalViewProps } from "./views/temporal-view.js";
export { TemporalView } from "./views/temporal-view.js";
// App
export type { TuiAppConfig, TuiAppHandle } from "./views/tui-app.js";
export { createTuiApp } from "./views/tui-app.js";
// Views — extracted modules
export type { CommandDeps } from "./views/tui-commands.js";
export { dispatchCommand, handleSlashCommand } from "./views/tui-commands.js";
// Views — consent
export type { ConsentDeps } from "./views/tui-consent.js";
export { closeConsent, consentApprove, consentDeny, consentDetails } from "./views/tui-consent.js";
export type { DataSourceDeps } from "./views/tui-data-sources.js";
export {
  approveDataSource,
  forwardConsentPrompts,
  openDataSources,
  rejectDataSource,
  rescanDataSources,
  viewDataSourceSchema,
} from "./views/tui-data-sources.js";
// Views — event stream
export type { EventForwardDeps } from "./views/tui-event-stream.js";
export {
  checkConsentPrompts,
  formatAgentEvent,
  formatDataSourceEvent,
  forwardAgentEventsToConsole,
  getDomainScrollOffset,
  viewToDomainKey,
} from "./views/tui-event-stream.js";
// Views — keyboard
export type { KeyboardCallbacks } from "./views/tui-keyboard.js";
export { createKeyboardHandler } from "./views/tui-keyboard.js";
// Views — TUI root
export type { TuiRootProps } from "./views/tui-root.js";
export { TuiRoot } from "./views/tui-root.js";
// Views — session management
export {
  fetchRecentAgentActivity,
  persistCurrentSession,
  restoreSession,
} from "./views/tui-session.js";
