/**
 * InputArea — text input component for the TUI.
 *
 * Uses OpenTUI <textarea> with Zig EditBuffer (undo/redo built in).
 * Decision 2A: Input buffer is local via textarea ref (not in TuiState).
 *
 * Features:
 * - Enter to submit, Shift+Enter for newline (Kitty protocol), Ctrl+J fallback
 * - Slash command detection at position 0 triggers overlay
 * - useKeyboard intercepts Enter globally before textarea receives it
 */

import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import type { JSX } from "solid-js";
import { detectSlashPrefix } from "../commands/slash-detection.js";
import { processInputKey } from "./input-keys.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Ref type for OpenTUI textarea renderable. */
interface TextareaRenderable {
  readonly plainText: string;
  setText(text: string): void;
}

export interface InputAreaProps {
  /** Called when the user submits text (Enter). */
  readonly onSubmit: (text: string) => void;
  /** Called when slash command prefix is detected. Null = no overlay. */
  readonly onSlashDetected: (query: string | null) => void;
  /** Whether input is disabled (e.g., modal active, disconnected). */
  readonly disabled?: boolean;
  /** Whether this area has keyboard focus. */
  readonly focused: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function InputArea(props: InputAreaProps): JSX.Element {
  let textareaRef: TextareaRenderable | null = null;

  useKeyboard((key: KeyEvent) => {
    if (!props.focused || (props.disabled ?? false)) return;

    const currentText = textareaRef?.plainText ?? "";
    const result = processInputKey(key, currentText);

    switch (result.kind) {
      case "submit": {
        key.preventDefault();
        if (result.text.trim() !== "") {
          props.onSubmit(result.text);
        }
        textareaRef?.setText("");
        props.onSlashDetected(null);
        break;
      }
      case "clear-line":
        key.preventDefault();
        textareaRef?.setText("");
        props.onSlashDetected(null);
        break;
      case "insert-newline":
        // Let textarea handle the actual newline insertion
        break;
      case "insert-char": {
        // After this key is processed by textarea, check for slash
        // Use queueMicrotask to read the updated plainText after textarea processes it
        queueMicrotask(() => {
          const text = textareaRef?.plainText ?? "";
          props.onSlashDetected(detectSlashPrefix(text));
        });
        break;
      }
      case "backspace":
      case "delete-word": {
        queueMicrotask(() => {
          const text = textareaRef?.plainText ?? "";
          props.onSlashDetected(detectSlashPrefix(text));
        });
        break;
      }
      case "noop":
        break;
    }
  });

  // Register global keyboard handler (OpenTUI pattern: intercepts before textarea)

  return (
    <box flexDirection="column">
      <textarea
        ref={(el: TextareaRenderable | null) => {
          textareaRef = el;
        }}
        height={3}
        focused={props.focused && !(props.disabled ?? false)}
        placeholder={(props.disabled ?? false) ? "" : "Type a message... (/ for commands)"}
      />
    </box>
  );
}
