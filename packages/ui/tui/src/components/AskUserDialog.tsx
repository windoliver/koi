/**
 * AskUserDialog — text input modal for when the agent requests user input
 * via the ask_user tool.
 *
 * Uses OpenTUI <textarea> for text input with Zig EditBuffer (undo/redo built in).
 * Enter submits the response, Escape sends an empty response (dismisses).
 */

import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import React, { memo, useCallback, useRef } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Ref type for OpenTUI textarea renderable. */
interface TextareaRenderable {
  readonly plainText: string;
  setText(text: string): void;
}

export interface AskUserDialogProps {
  /** The question the agent is asking. */
  readonly question: string;
  /** Called when the user submits a response. */
  readonly onRespond: (response: string) => void;
  /** Called when the user dismisses without responding. */
  readonly onDismiss: () => void;
  /** Whether this dialog has keyboard focus. */
  readonly focused: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const AskUserDialog: React.NamedExoticComponent<AskUserDialogProps> = memo(function AskUserDialog(
  props: AskUserDialogProps,
): React.ReactNode {
  const { question, onRespond, onDismiss, focused } = props;
  const textareaRef = useRef<TextareaRenderable | null>(null);

  const handleKey = useCallback(
    (key: KeyEvent) => {
      if (!focused) return;
      if (key.name === "return" && !key.shift) {
        key.preventDefault();
        const text = textareaRef.current?.plainText ?? "";
        onRespond(text.trim());
      }
      if (key.name === "escape") {
        key.preventDefault();
        onDismiss();
      }
    },
    [focused, onRespond, onDismiss],
  );

  useKeyboard(handleKey);

  return (
    <box
      flexDirection="column"
      border={true}
      borderColor="#60A5FA"
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg="#E2E8F0"><b>{"Agent is asking:"}</b></text>
      <box marginTop={1}>
        <text fg="#94A3B8">{question}</text>
      </box>

      <box marginTop={1}>
        <textarea
          ref={(el: TextareaRenderable | null) => {
            textareaRef.current = el;
          }}
          height={3}
          focused={focused}
          placeholder="Type your response..."
        />
      </box>

      {focused ? (
        <box flexDirection="row" marginTop={1} gap={2}>
          <text fg="#4ADE80">{"[Enter] Submit"}</text>
          <text fg="#F87171">{"[Esc] Dismiss"}</text>
        </box>
      ) : null}
    </box>
  );
});
