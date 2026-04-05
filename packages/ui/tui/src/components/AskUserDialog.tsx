/**
 * AskUserDialog — text input modal for when the agent requests user input
 * via the ask_user tool.
 *
 * Uses OpenTUI <textarea> for text input with Zig EditBuffer (undo/redo built in).
 * Enter submits the response, Escape sends an empty response (dismisses).
 */

import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import type { JSX } from "solid-js";
import { Show } from "solid-js";
import { COLORS } from "../theme.js";

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

export function AskUserDialog(props: AskUserDialogProps): JSX.Element {
  let textareaRef: TextareaRenderable | null = null;

  useKeyboard((key: KeyEvent) => {
    if (!props.focused) return;
    if (key.name === "return" && !key.shift) {
      key.preventDefault();
      const text = textareaRef?.plainText ?? "";
      props.onRespond(text.trim());
    }
    if (key.name === "escape") {
      key.preventDefault();
      props.onDismiss();
    }
  });

  return (
    <box
      flexDirection="column"
      border={true}
      borderColor={COLORS.blueAccent}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={COLORS.white}><b>{"Agent is asking:"}</b></text>
      <box marginTop={1}>
        <text fg={COLORS.textSecondary}>{props.question}</text>
      </box>

      <box marginTop={1}>
        <textarea
          ref={(el: TextareaRenderable | null) => {
            textareaRef = el;
          }}
          height={3}
          focused={props.focused}
          placeholder="Type your response..."
        />
      </box>

      <Show when={props.focused}>
        <box flexDirection="row" marginTop={1} gap={2}>
          <text fg={COLORS.success}>{"[Enter] Submit"}</text>
          <text fg={COLORS.danger}>{"[Esc] Dismiss"}</text>
        </box>
      </Show>
    </box>
  );
}
