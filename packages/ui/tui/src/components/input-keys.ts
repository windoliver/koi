/**
 * Input key handling — pure functions for interpreting keyboard input.
 *
 * Decision 12A: Support both Kitty protocol (Shift+Enter) and legacy mode.
 * Decision 2A: Input buffer is local React state, not in TuiState.
 *
 * OpenTUI's KeyEvent provides `.source: "raw" | "kitty"` so we can detect
 * Kitty protocol automatically — no manual enable/disable needed.
 *
 * Kitty keyboard protocol:
 * - When enabled, Shift+Enter is detectable via key.shift + key.name === "return"
 * - Legacy terminals ("raw" source) send 0x0D for both → indistinguishable
 * - Fallback: Ctrl+J (0x0A, line feed) always works for newline insertion
 */

import type { KeyEvent } from "@opentui/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of processing a key input for the text area. */
export type InputKeyResult =
  | { readonly kind: "submit"; readonly text: string }
  | { readonly kind: "insert-newline" }
  | { readonly kind: "insert-char"; readonly char: string }
  | { readonly kind: "backspace" }
  | { readonly kind: "delete-word" }
  | { readonly kind: "clear-line" }
  | { readonly kind: "history-up" }
  | { readonly kind: "history-down" }
  | { readonly kind: "noop" };

// ---------------------------------------------------------------------------
// Key processing
// ---------------------------------------------------------------------------

/**
 * Process a KeyEvent and return the intended action.
 *
 * @param key - OpenTUI KeyEvent from useKeyboard
 * @param currentText - Current text in the input buffer
 */
export function processInputKey(key: KeyEvent, currentText: string): InputKeyResult {
  const kittyEnabled = key.source === "kitty";

  // Escape — do nothing in the input (handled by parent for modal dismiss)
  if (key.name === "escape") {
    return { kind: "noop" };
  }

  // Enter / Return
  if (key.name === "return") {
    if (kittyEnabled && key.shift) {
      // Kitty protocol: Shift+Enter = newline
      return { kind: "insert-newline" };
    }
    // Plain Enter = submit (both Kitty and legacy)
    return { kind: "submit", text: currentText };
  }

  // Ctrl+J: universal newline fallback (0x0A, works in all terminals)
  if (key.ctrl && key.name === "j") {
    return { kind: "insert-newline" };
  }

  // Ctrl+C: submit empty (cancel / interrupt)
  if (key.ctrl && key.name === "c") {
    return { kind: "submit", text: "" };
  }

  // Backspace
  if (key.name === "backspace") {
    if (key.ctrl) {
      return { kind: "delete-word" };
    }
    return { kind: "backspace" };
  }

  // Ctrl+U: clear line
  if (key.ctrl && key.name === "u") {
    return { kind: "clear-line" };
  }

  // Up/Down: prompt history navigation (bare keys only, not Ctrl/Meta modified)
  // Ctrl+Up/Down are reserved for other bindings (not consumed here).
  if (key.name === "up" && !key.ctrl && !key.meta) {
    return { kind: "history-up" };
  }
  if (key.name === "down" && !key.ctrl && !key.meta) {
    return { kind: "history-down" };
  }

  // Tab — do nothing in normal input (slash overlay handles tab)
  if (key.name === "tab") {
    return { kind: "noop" };
  }

  // Printable character
  if (key.name.length === 1 && !key.ctrl && !key.meta) {
    return { kind: "insert-char", char: key.name };
  }

  return { kind: "noop" };
}
