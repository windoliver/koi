/**
 * Pure key-handler helper for SelectOverlay — exported as a plain .ts file so
 * tests can import it without triggering the JSX runtime.
 */

import type { KeyEvent } from "@opentui/core";

/** Process a key for any select overlay. Returns true if consumed. */
export function handleSelectOverlayKey(
  key: KeyEvent,
  callbacks: {
    readonly onClose: () => void;
    readonly onSelect?: (() => void) | undefined;
    readonly onMoveUp?: (() => void) | undefined;
    readonly onMoveDown?: (() => void) | undefined;
  },
): boolean {
  if (key.name === "escape") {
    callbacks.onClose();
    return true;
  }
  if (key.name === "return" || key.name === "tab") {
    callbacks.onSelect?.();
    return true;
  }
  if (key.name === "up" || (key.ctrl && key.name === "p")) {
    callbacks.onMoveUp?.();
    return true;
  }
  if (key.name === "down" || (key.ctrl && key.name === "n")) {
    callbacks.onMoveDown?.();
    return true;
  }
  return false;
}
