/**
 * Component re-exports for @koi/tui/components subpath.
 */

export { AskUserDialog, type AskUserDialogProps } from "./AskUserDialog.js";
export { ConfirmDialog, type ConfirmDialogProps, processConfirmKey } from "./ConfirmDialog.js";
// React components (require @opentui/react)
export { InputArea, type InputAreaProps } from "./InputArea.js";
// Pure key handling (framework-agnostic, testable without React)
export type { InputKeyResult } from "./input-keys.js";
export { processInputKey } from "./input-keys.js";
export {
  formatInputPreview,
  PermissionPrompt,
  type PermissionPromptProps,
  processPermissionKey,
} from "./PermissionPrompt.js";
export { handleSlashOverlayKey, SlashOverlay, type SlashOverlayProps } from "./SlashOverlay.js";
