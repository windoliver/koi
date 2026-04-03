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
import { useKeyboard } from "@opentui/react";
import React, { memo, useCallback, useRef } from "react";
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

export const InputArea: React.NamedExoticComponent<InputAreaProps> = memo(function InputArea(props: InputAreaProps): React.ReactNode {
  const { onSubmit, onSlashDetected, disabled = false, focused } = props;
  const textareaRef = useRef<TextareaRenderable | null>(null);

  const handleKey = useCallback(
    (key: KeyEvent) => {
      if (!focused || disabled) return;

      const currentText = textareaRef.current?.plainText ?? "";
      const result = processInputKey(key, currentText);

      switch (result.kind) {
        case "submit": {
          key.preventDefault();
          if (result.text.trim() !== "") {
            onSubmit(result.text);
          }
          textareaRef.current?.setText("");
          onSlashDetected(null);
          break;
        }
        case "clear-line":
          key.preventDefault();
          textareaRef.current?.setText("");
          onSlashDetected(null);
          break;
        case "insert-newline":
          // Let textarea handle the actual newline insertion
          break;
        case "insert-char": {
          // After this key is processed by textarea, check for slash
          // Use queueMicrotask to read the updated plainText after textarea processes it
          queueMicrotask(() => {
            const text = textareaRef.current?.plainText ?? "";
            onSlashDetected(detectSlashPrefix(text));
          });
          break;
        }
        case "backspace":
        case "delete-word": {
          queueMicrotask(() => {
            const text = textareaRef.current?.plainText ?? "";
            onSlashDetected(detectSlashPrefix(text));
          });
          break;
        }
        case "noop":
        case "history-prev":
        case "history-next":
          break;
      }
    },
    [focused, disabled, onSubmit, onSlashDetected],
  );

  // Register global keyboard handler (OpenTUI pattern: intercepts before textarea)
  useKeyboard(handleKey);

  return (
    <box flexDirection="column">
      <textarea
        ref={(el: TextareaRenderable | null) => {
          textareaRef.current = el;
        }}
        height={3}
        focused={focused && !disabled}
        placeholder={disabled ? "" : "Type a message... (/ for commands)"}
      />
    </box>
  );
});
