/**
 * @koi/tui — OpenTUI-based terminal UI for Koi agent conversations.
 *
 * Root entry is framework-agnostic: state, bridge, commands, and pure key handling.
 * React/OpenTUI components are available only via the `@koi/tui/components` subpath
 * so non-TUI consumers don't pull in the OpenTUI runtime.
 */

// EventBatcher — 16ms rate-limiter for engine event → store dispatch pipeline
export type { EventBatcher, EventBatcherOptions } from "./batcher/event-batcher.js";
export { createEventBatcher } from "./batcher/event-batcher.js";
// Bridge
export type { PermissionBridge, PermissionBridgeOptions } from "./bridge/permission-bridge.js";
export {
  createPermissionBridge,
  DEFAULT_PERMISSION_TIMEOUT_MS,
} from "./bridge/permission-bridge.js";
// Commands — palette definitions + fuzzy matching
export type { CommandCategory, CommandDef, CommandId } from "./commands/command-definitions.js";
export { COMMAND_DEFINITIONS, filterCommands } from "./commands/command-definitions.js";
export { fuzzyFilter, fuzzyScore } from "./commands/fuzzy-match.js";
// Commands — slash detection
export type { SlashCommand, SlashMatch, SlashParseResult } from "./commands/slash-detection.js";
export { detectSlashPrefix, matchCommands, parseSlashCommand } from "./commands/slash-detection.js";
// Pure key handling (framework-agnostic — no React/OpenTUI import)
export type { InputKeyResult } from "./components/input-keys.js";
export { processInputKey } from "./components/input-keys.js";
// Factory — createTuiApp (Phase 2j-5)
export type {
  CreateTuiAppConfig,
  TuiAppHandle,
  TuiStartError,
} from "./create-app.js";
export { createTuiApp } from "./create-app.js";
// Key event predicates (framework-agnostic — no React/OpenTUI import)
export {
  isBackspace,
  isCtrlC,
  isCtrlJ,
  isCtrlP,
  isEnter,
  isEscape,
  isTab,
} from "./key-event.js";
// Global keyboard handler (Phase 2j-5)
export type { GlobalKeyCallbacks } from "./keyboard.js";
export { createKeyboardHandler, handleGlobalKey } from "./keyboard.js";
// State management
export * from "./state/index.js";
// Plugin summary types
export type { PluginSummary, PluginSummaryEntry, PluginSummaryError } from "./state/types.js";
// Store context — the SolidJS store provides reactivity directly through StoreContext.
// Components that use useTuiStore must be rendered inside StoreContext.Provider
// (or inside TuiRoot, which provides it automatically).
export {
  StoreContext,
  useTuiStore,
} from "./store-context.js";
// Theme — color tokens + layout helpers (Phase 2j-5)
export {
  abbreviateModel,
  COLORS,
  CONNECTION_STATUS_CONFIG,
  computeLayoutTier,
  separator,
  truncate,
} from "./theme.js";
// TuiRoot component (requires @opentui/solid at runtime)
export type { TuiRootProps } from "./tui-root.js";
export { resolveNavCommand, TuiRoot } from "./tui-root.js";

// EngineChannel — main-thread bridge: worker postMessage → EventBatcher → store
export type {
  CreateEngineChannelConfig,
  EngineChannelHandle,
  WorkerLike,
} from "./worker/engine-channel.js";
export { createEngineChannel } from "./worker/engine-channel.js";
