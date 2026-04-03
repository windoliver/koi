/**
 * Component re-exports for @koi/tui/components subpath.
 */

// Phase 2j-3: Input + permission prompt components
export { AskUserDialog, type AskUserDialogProps } from "./AskUserDialog.js";
export { ConfirmDialog, type ConfirmDialogProps, processConfirmKey } from "./ConfirmDialog.js";
// Message rendering components
export { ErrorBlock } from "./error-block.js";
export { InputArea, type InputAreaProps } from "./InputArea.js";
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
export { handleSlashOverlayKey, SlashOverlay, type SlashOverlayProps } from "./SlashOverlay.js";
export { TextBlock } from "./text-block.js";
export { ThinkingBlock } from "./thinking-block.js";
export { ToolCallBlock } from "./tool-call-block.js";
