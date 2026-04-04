/**
 * Pure key-handler helper for SelectOverlay — exported as a plain .ts file so
 * tests can import it without triggering the JSX runtime.
 */

import type { KeyEvent } from "@opentui/core";

/** Process a key for any select overlay. Returns true if consumed. */
export function handleSelectOverlayKey(
  key: KeyEvent,
  callbacks: { readonly onClose: () => void },
): boolean {
  if (key.name === "escape") {
    callbacks.onClose();
    return true;
  }
  return false;
}
