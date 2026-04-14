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
import { createEffect, createSignal, on, onCleanup, Show } from "solid-js";
import { detectAtPrefix } from "../commands/at-detection.js";
import { detectSlashPrefix } from "../commands/slash-detection.js";
import type { ClipboardImage } from "../utils/clipboard.js";
import { readClipboardImage } from "../utils/clipboard.js";
import { COLORS } from "../theme.js";
import { processInputKey } from "./input-keys.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Ref type for OpenTUI textarea renderable. */
interface TextareaRenderable {
  readonly plainText: string;
  setText(text: string): void;
  setCursor(row: number, col: number): void;
}

export interface InputAreaProps {
  /** Called when the user submits text (Enter). */
  readonly onSubmit: (text: string) => void;
  /** Called when slash command prefix is detected. Null = no overlay. */
  readonly onSlashDetected: (query: string | null) => void;
  /**
   * Called when the user presses Enter while a slash command is in the input.
   * InputArea handles this directly instead of relying on SlashOverlay's
   * useKeyboard handler, because OpenTUI's preventDefault() stops event
   * propagation to sibling component handlers.
   */
  readonly onSlashSubmit?: ((text: string) => void) | undefined;
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
  /**
   * When set, replaces the current @-mention partial in the textarea with
   * this file path (formatted as "@path "). Cleared back to null by the parent
   * after each insertion. Uses deferred effect — the initial null does not trigger.
   */
  readonly atInsertPath?: string | null | undefined;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function InputArea(props: InputAreaProps): JSX.Element {
  let textareaRef: TextareaRenderable | null = null;
  // #11: track attached images (component-local, not in TuiState)
  const [attachedImages, setAttachedImages] = createSignal<readonly ClipboardImage[]>([]);

  // #1744: keypress events can drain through the renderer's KeyHandler after the
  // textarea's underlying EditBuffer has been destroyed during shutdown. Reads on
  // a destroyed buffer throw "EditBuffer is destroyed". Drop the ref and bail out
  // of the keypress callback once the component is being torn down so neither
  // reads nor writes hit a dead buffer.
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    textareaRef = null;
  });
  function safeText(): string {
    if (disposed || textareaRef === null) return "";
    try {
      return textareaRef.plainText;
    } catch {
      return "";
    }
  }
  function safeSetText(text: string): void {
    if (disposed || textareaRef === null) return;
    try {
      textareaRef.setText(text);
    } catch {
      /* buffer destroyed during teardown — drop the write */
    }
  }

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
        safeSetText("");
        props.onSlashDetected(null);
      },
      { defer: true },
    ),
  );

  // #10: replace @-partial with selected file path when atInsertPath changes
  createEffect(
    on(
      () => props.atInsertPath,
      (path) => {
        if (path === null || path === undefined) return;
        const text = safeText();
        const lastAt = text.lastIndexOf("@");
        if (lastAt < 0) return;
        // Replace everything from "@" to end with "@selectedPath ".
        // Quote paths containing spaces so the @-reference parser can
        // round-trip them correctly (unquoted @path stops at first space).
        const before = text.slice(0, lastAt);
        const formattedRef = path.includes(" ") ? `@"${path}"` : `@${path}`;
        const newText = `${before}${formattedRef} `;
        safeSetText(newText);
        // Move cursor to end of inserted text so the user can continue typing
        if (!disposed && textareaRef !== null) {
          try {
            textareaRef.setCursor(0, newText.length);
          } catch {
            /* buffer destroyed during teardown */
          }
        }
        // Dismiss the overlay after insertion
        props.onAtDetected?.(null);
      },
      { defer: true },
    ),
  );

  useKeyboard((key: KeyEvent) => {
    if (disposed || !props.focused || disabledRef) return;

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

    const currentText = safeText();
    const result = processInputKey(key, currentText);

    switch (result.kind) {
      case "submit": {
        key.preventDefault();
        // When the text starts with "/", dispatch as a slash command.
        // Previously this relied on SlashOverlay's useKeyboard catching
        // Enter, but OpenTUI's preventDefault() stops propagation to
        // sibling handlers. Handle it directly here instead.
        if (result.text.trim() !== "" && detectSlashPrefix(result.text) !== null) {
          props.onSlashSubmit?.(result.text);
          safeSetText("");
          props.onSlashDetected(null);
          break;
        }
        // #10: Same guard for @-mention overlay. When an active @-mention
        // is detected (no space after @), the AtOverlay owns Enter —
        // SelectOverlay handles the selection and inserts the file path.
        // Once inserted, the trailing space makes detectAtPrefix return
        // null, so the next Enter submits normally. Matches CC behavior:
        // Enter with active suggestions = select, not submit.
        if (detectAtPrefix(result.text) !== null) {
          break;
        }
        if (result.text.trim() !== "") {
          props.onSubmit(result.text);
        }
        safeSetText("");
        props.onSlashDetected(null);
        props.onAtDetected?.(null);
        setAttachedImages([]);
        break;
      }
      case "clear-line":
        key.preventDefault();
        safeSetText("");
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
          const text = safeText();
          const slash = detectSlashPrefix(text);
          props.onSlashDetected(slash);
          props.onAtDetected?.(detectAtPrefix(text));
        });
        break;
      }
      case "backspace":
      case "delete-word": {
        queueMicrotask(() => {
          const text = safeText();
          props.onSlashDetected(detectSlashPrefix(text));
          props.onAtDetected?.(detectAtPrefix(text));
        });
        break;
      }
      case "history-up":
      case "history-down": {
        const text = safeText();
        // Skip history when:
        // - Multiline input: let textarea handle normal caret movement
        // - Slash overlay active: let overlay own Up/Down for selection
        // - @-mention overlay active: let AtOverlay own Up/Down for file selection
        const isMultiline = text.includes("\n");
        const slashActive = detectSlashPrefix(text) !== null;
        const atActive = detectAtPrefix(text) !== null;
        if (isMultiline || slashActive || atActive) break;

        key.preventDefault();
        if (props.onHistoryNav) {
          const direction = result.kind === "history-up" ? "up" : "down";
          const historyText = props.onHistoryNav(direction, text);
          if (historyText !== null) {
            safeSetText(historyText);
            // Recompute slash and @-mention state after programmatic text
            // replacement so overlays stay in sync with buffer contents
            queueMicrotask(() => {
              props.onSlashDetected(detectSlashPrefix(historyText));
              props.onAtDetected?.(detectAtPrefix(historyText));
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
    <box flexDirection="column" flexShrink={0}>
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
