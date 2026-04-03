/**
 * ConfirmDialog — generic confirmation modal for destructive actions.
 *
 * Single-key responses:
 *   y / Enter = confirm
 *   n / Escape = cancel
 *
 * Rendered as an OpenTUI <box> overlay. Parent handles focus routing.
 */

import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import React, { memo, useCallback } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConfirmDialogProps {
  /** What the user is confirming (e.g., "Clear all messages?"). */
  readonly message: string;
  /** Optional details text shown below the message. */
  readonly details?: string;
  /** Called when the user confirms. */
  readonly onConfirm: () => void;
  /** Called when the user cancels. */
  readonly onCancel: () => void;
  /** Whether this dialog has keyboard focus. */
  readonly focused: boolean;
}

// ---------------------------------------------------------------------------
// Key handling (pure, exported for testing)
// ---------------------------------------------------------------------------

/** Map a key name to a confirm/cancel action, or null if not valid. */
export function processConfirmKey(keyName: string): "confirm" | "cancel" | null {
  switch (keyName) {
    case "y":
    case "return":
      return "confirm";
    case "n":
    case "escape":
      return "cancel";
    default:
      return null; // focus trap
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const ConfirmDialog: React.NamedExoticComponent<ConfirmDialogProps> = memo(function ConfirmDialog(
  props: ConfirmDialogProps,
): React.ReactNode {
  const { message, details, onConfirm, onCancel, focused } = props;

  const handleKey = useCallback(
    (key: KeyEvent) => {
      if (!focused) return;
      const result = processConfirmKey(key.name);
      if (result === "confirm") {
        key.preventDefault();
        onConfirm();
      } else if (result === "cancel") {
        key.preventDefault();
        onCancel();
      }
    },
    [onConfirm, onCancel, focused],
  );

  useKeyboard(handleKey);

  return (
    <box
      flexDirection="column"
      border={true}
      borderColor="#FBBF24"
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg="#E2E8F0"><b>{message}</b></text>

      {details !== undefined ? (
        <box marginTop={1}>
          <text fg="#94A3B8">{details}</text>
        </box>
      ) : null}

      {focused ? (
        <box flexDirection="row" marginTop={1} gap={2}>
          <text fg="#4ADE80">{"[y/Enter] Confirm"}</text>
          <text fg="#F87171">{"[n/Esc] Cancel"}</text>
        </box>
      ) : null}
    </box>
  );
});
