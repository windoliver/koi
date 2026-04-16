/**
 * Component re-exports for @koi/tui/components subpath.
 */

// Phase 2j-3: Input + permission prompt components
export { AskUserDialog, type AskUserDialogProps } from "./AskUserDialog.js";
// Phase 2j-4: Status bar + command palette + session picker
export { CommandPalette, type CommandPaletteProps } from "./CommandPalette.js";
export { ConfirmDialog, type ConfirmDialogProps, processConfirmKey } from "./ConfirmDialog.js";
export { CostDashboardView } from "./CostDashboardView.js";
// Message rendering components
export { ErrorBlock } from "./error-block.js";
export { InputArea, type InputAreaProps } from "./InputArea.js";
export { InfoBlock } from "./info-block.js";
export type { InputKeyResult } from "./input-keys.js";
export { processInputKey } from "./input-keys.js";
export { MessageList } from "./message-list.js";
export { MessageRow } from "./message-row.js";
export {
  formatInputPreview,
  PermissionPrompt,
  type PermissionPromptProps,
  processPermissionKey,
} from "./PermissionPrompt.js";
export {
  handleSelectOverlayKey,
  SelectOverlay,
  type SelectOverlayProps,
} from "./SelectOverlay.js";
export { SessionPicker, type SessionPickerProps } from "./SessionPicker.js";
export { SlashOverlay, type SlashOverlayProps } from "./SlashOverlay.js";
export { StatusBar, type StatusBarProps } from "./StatusBar.js";
export { formatSessionDate, getSessionDescription } from "./session-picker-helpers.js";
// Phase 2j-4: Pure helpers (importable without JSX runtime)
export { formatCost, formatTokens } from "./status-bar-helpers.js";
export { TrajectoryView } from "./TrajectoryView.js";
export { TextBlock } from "./text-block.js";
export { ThinkingBlock } from "./thinking-block.js";
export { ToolCallBlock } from "./tool-call-block.js";
