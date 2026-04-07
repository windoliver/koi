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
import { createEffect, on } from "solid-js";
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
  /**
   * Called when the user navigates prompt history (arrow up/down).
   * Receives the current textarea text so the draft can be saved/restored.
   */
  readonly onHistoryNav?: ((direction: "up" | "down", currentText: string) => string | null) | undefined;
  /** Whether input is disabled (e.g., modal active, disconnected). */
  readonly disabled?: boolean;
  /** Whether this area has keyboard focus. */
  readonly focused: boolean;
  /**
   * Increment this counter to imperatively clear the textarea.
   * Used by parent after slash-command selection to wipe the "/cmd" text.
   * The initial value (on mount) does NOT trigger a clear — only changes do.
   */
  readonly clearTrigger?: number | undefined;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function InputArea(props: InputAreaProps): JSX.Element {
  let textareaRef: TextareaRenderable | null = null;

  // `let` justified: mutable mirror of props.disabled for useKeyboard callback.
  // useKeyboard registers its callback once via onMount (OpenTUI pattern).
  // Reading props.disabled directly inside that callback may not trigger Solid's
  // reactive getter in all execution contexts, so we track changes explicitly
  // via createEffect and write to a plain mutable variable that is always safe
  // to read from a non-reactive callback.
  let disabledRef = props.disabled ?? false;
  createEffect(() => {
    disabledRef = props.disabled ?? false;
  });

  // Clear textarea when clearTrigger increments (defer skips the initial value)
  createEffect(
    on(
      () => props.clearTrigger,
      () => {
        textareaRef?.setText("");
        props.onSlashDetected(null);
      },
      { defer: true },
    ),
  );

  useKeyboard((key: KeyEvent) => {
    if (!props.focused || disabledRef) return;

    const currentText = textareaRef?.plainText ?? "";
    const result = processInputKey(key, currentText);

    switch (result.kind) {
      case "submit": {
        key.preventDefault();
        // Synchronous slash-prefix guard: block submit if the text is a slash command
        // prefix (e.g. "/" or "/cmd"). This works even when "/" and Enter arrive in the
        // same input batch — before the microtask-deferred store update can set disabledRef.
        if (result.text.trim() !== "" && detectSlashPrefix(result.text) === null) {
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
        // OpenTUI processes key events synchronously before yielding to the
        // microtask queue, so the textarea's plainText is updated by the time
        // this microtask fires. This contract is not documented in the OpenTUI
        // API — if a future version defers textarea updates asynchronously,
        // replace this with an onInput/onChange callback on <textarea> instead.
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
      case "history-up":
      case "history-down": {
        // Only navigate history when the input is single-line (no multiline
        // caret movement to steal) or empty. This prevents Up/Down from
        // destroying multiline drafts — the user keeps normal caret movement
        // in multiline text and uses history only when the buffer is simple.
        const text = textareaRef?.plainText ?? "";
        const isMultiline = text.includes("\n");
        if (isMultiline) break; // let textarea handle normal caret movement

        key.preventDefault();
        if (props.onHistoryNav) {
          const direction = result.kind === "history-up" ? "up" : "down";
          const historyText = props.onHistoryNav(direction, text);
          if (historyText !== null) {
            textareaRef?.setText(historyText);
          }
        }
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
        placeholder={props.disabled ?? false ? "" : "Type a message... (/ for commands)"}
      />
    </box>
  );
}
