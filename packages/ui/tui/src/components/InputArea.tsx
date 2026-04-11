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
import { createEffect, createSignal, on, Show } from "solid-js";
import { detectSlashPrefix } from "../commands/slash-detection.js";
import type { ClipboardImage } from "../utils/clipboard.js";
import { readClipboardImage } from "../utils/clipboard.js";
import { COLORS } from "../theme.js";
import { processInputKey } from "./input-keys.js";

/** Detect @-mention prefix — returns partial path or null. */
function detectAtPrefix(text: string): string | null {
  const lastAt = text.lastIndexOf("@");
  if (lastAt < 0) return null;
  if (lastAt > 0 && text[lastAt - 1] !== " " && text[lastAt - 1] !== "\n") return null;
  const partial = text.slice(lastAt + 1);
  if (partial.includes(" ") || partial.includes("\n")) return null;
  return partial;
}

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
  /**
   * Called when @-mention prefix is detected (#10).
   * Receives the partial path after "@", or null to dismiss the overlay.
   */
  readonly onAtDetected?: ((query: string | null) => void) | undefined;
  /**
   * Called when an image is pasted from the clipboard via Ctrl+V (#11).
   * Receives the image as a data URI.
   */
  readonly onImageAttach?: ((image: ClipboardImage) => void) | undefined;
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
  // #11: track attached images (component-local, not in TuiState)
  const [attachedImages, setAttachedImages] = createSignal<readonly ClipboardImage[]>([]);

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

    // #11: Ctrl+V — check clipboard for image before normal paste
    if (key.ctrl && key.name === "v") {
      readClipboardImage().then((image) => {
        if (image) {
          setAttachedImages((prev) => [...prev, image]);
          props.onImageAttach?.(image);
        }
      });
      // Don't prevent default — let terminal paste text too if present
    }

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
        props.onAtDetected?.(null);
        setAttachedImages([]);
        break;
      }
      case "clear-line":
        key.preventDefault();
        textareaRef?.setText("");
        props.onSlashDetected(null);
        props.onAtDetected?.(null);
        setAttachedImages([]);
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
          props.onAtDetected?.(detectAtPrefix(text));
        });
        break;
      }
      case "backspace":
      case "delete-word": {
        queueMicrotask(() => {
          const text = textareaRef?.plainText ?? "";
          props.onSlashDetected(detectSlashPrefix(text));
          props.onAtDetected?.(detectAtPrefix(text));
        });
        break;
      }
      case "history-up":
      case "history-down": {
        const text = textareaRef?.plainText ?? "";
        // Skip history when:
        // - Multiline input: let textarea handle normal caret movement
        // - Slash overlay active: let overlay own Up/Down for selection
        const isMultiline = text.includes("\n");
        const slashActive = detectSlashPrefix(text) !== null;
        if (isMultiline || slashActive) break;

        key.preventDefault();
        if (props.onHistoryNav) {
          const direction = result.kind === "history-up" ? "up" : "down";
          const historyText = props.onHistoryNav(direction, text);
          if (historyText !== null) {
            textareaRef?.setText(historyText);
            // Recompute slash state after programmatic text replacement
            // so the overlay stays in sync with the buffer contents
            queueMicrotask(() => {
              props.onSlashDetected(detectSlashPrefix(historyText));
            });
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
      {/* #11: image attachment indicator */}
      <Show when={attachedImages().length > 0}>
        <box flexDirection="row" paddingLeft={1} gap={1}>
          <text fg={COLORS.cyan}>
            {`[${attachedImages().length} image${attachedImages().length > 1 ? "s" : ""} attached]`}
          </text>
        </box>
      </Show>
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
