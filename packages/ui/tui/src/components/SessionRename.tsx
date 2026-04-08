/**
 * SessionRename — modal overlay for renaming the current session (#14).
 *
 * Pre-fills the input with the current session name from sessionInfo.
 * On confirm (Enter): dispatches onRename with the new name.
 * On dismiss (Esc): calls onClose.
 */

import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import type { JSX } from "solid-js";
import { createEffect, createSignal, on } from "solid-js";
import { useTuiStore } from "../store-context.js";
import { COLORS, MODAL_POSITION } from "../theme.js";

export interface SessionRenameProps {
  /** Called with the new name when the user confirms. */
  readonly onRename: (newName: string) => void;
  /** Called when the user dismisses (Escape). */
  readonly onClose: () => void;
  /** Whether this modal has keyboard focus. */
  readonly focused: boolean;
}

/** Ref type for OpenTUI textarea renderable. */
interface TextareaRenderable {
  readonly plainText: string;
  setText(text: string): void;
}

export function SessionRename(props: SessionRenameProps): JSX.Element {
  const sessionInfo = useTuiStore((s) => s.sessionInfo);
  const currentName = () => sessionInfo()?.sessionName ?? "";
  const [value, setValue] = createSignal(currentName());
  let textareaRef: TextareaRenderable | null = null;

  // Pre-fill with current session name when modal opens
  createEffect(
    on(currentName, (name: string) => {
      setValue(name);
      textareaRef?.setText(name);
    }),
  );

  useKeyboard((key: KeyEvent) => {
    if (!props.focused) return;
    if (key.name === "escape") {
      props.onClose();
      return;
    }
    if (key.name === "return" && !key.shift) {
      key.preventDefault();
      const text = (textareaRef?.plainText ?? value()).trim();
      if (text.length > 0) {
        props.onRename(text);
      }
    }
  });

  return (
    <box
      flexDirection="column"
      border={true}
      borderColor={COLORS.purple}
      width={60}
      {...MODAL_POSITION}
    >
      {/* Header */}
      <box paddingLeft={1} paddingTop={1} paddingBottom={1}>
        <text fg={COLORS.purple}>
          <b>{"Rename session"}</b>
        </text>
        <text fg={COLORS.textMuted}>{" — Enter to confirm, Esc to cancel"}</text>
      </box>

      {/* Name input */}
      <box paddingLeft={1} paddingRight={1} paddingBottom={1}>
        <textarea
          ref={(el: TextareaRenderable | null) => {
            textareaRef = el;
          }}
          height={1}
          focused={props.focused}
          placeholder="Session name…"
        />
      </box>
    </box>
  );
}
