/**
 * @koi/tui — OpenTUI-based terminal UI for Koi agent conversations.
 *
 * Root entry is framework-agnostic: state, bridge, commands, and pure key handling.
 * React/OpenTUI components are available only via the `@koi/tui/components` subpath
 * so non-TUI consumers don't pull in the OpenTUI runtime.
 */

// Bridge
export type { PermissionBridge, PermissionBridgeOptions } from "./bridge/permission-bridge.js";
export {
  createPermissionBridge,
  DEFAULT_PERMISSION_TIMEOUT_MS,
} from "./bridge/permission-bridge.js";
// Commands
export type { SlashCommand, SlashMatch, SlashParseResult } from "./commands/slash-detection.js";
export { detectSlashPrefix, matchCommands, parseSlashCommand } from "./commands/slash-detection.js";
// Pure key handling (framework-agnostic — no React/OpenTUI import)
export type { InputKeyResult } from "./components/input-keys.js";
export { processInputKey } from "./components/input-keys.js";
// State management
export * from "./state/index.js";
// Store context (React hook — requires @opentui/react at runtime)
export { StoreContext, useTuiStore } from "./store-context.js";
