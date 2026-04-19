/**
 * Regression for the modal-overlay Enter-leak bug.
 *
 * When a focused overlay (SessionPicker, SlashOverlay, or any other
 * `SelectOverlay`-based modal) consumes Enter, it MUST call
 * `key.preventDefault()` so the keystroke does not leak through to
 * InputArea's underlying OpenTUI <textarea>. Prior to the fix, the overlay's
 * `useKeyboard` handler fired `onSelect` but left `preventDefault`
 * un-called; the textarea then inserted `"\n"` into its buffer. Once the
 * modal closed, the textarea held `"\n"`, so the user's next `/command`
 * became `"\n/command"`, which `detectSlashPrefix` rejects (position-0
 * match only) — and the command text was submitted to the LLM as a regular
 * user message instead of opening the picker.
 *
 * `consumeSelectOverlayKey` is the single wrapper every overlay routes
 * through, so the preventDefault invariant is a unit-testable contract
 * rather than per-component copy-paste.
 */

import { describe, expect, mock, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { consumeSelectOverlayKey } from "./select-overlay-helpers.js";

function mockKey(
  name: string,
  ctrl = false,
): KeyEvent & { readonly preventDefault: ReturnType<typeof mock> } {
  const preventDefault = mock(() => {});
  return {
    name,
    ctrl,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: name,
    raw: name,
    eventType: "press",
    source: "raw",
    preventDefault,
    stopPropagation: () => {},
    defaultPrevented: false,
    propagationStopped: false,
  } as unknown as KeyEvent & { readonly preventDefault: ReturnType<typeof mock> };
}

describe("consumeSelectOverlayKey — preventDefault invariant", () => {
  test("Enter: onSelect fires AND preventDefault is called", () => {
    const onSelect = mock(() => {});
    const key = mockKey("return");
    const consumed = consumeSelectOverlayKey(key, { onClose: () => {}, onSelect });
    expect(consumed).toBe(true);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(key.preventDefault).toHaveBeenCalledTimes(1);
  });

  test("Escape: onClose fires AND preventDefault is called", () => {
    const onClose = mock(() => {});
    const key = mockKey("escape");
    const consumed = consumeSelectOverlayKey(key, { onClose });
    expect(consumed).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(key.preventDefault).toHaveBeenCalledTimes(1);
  });

  test("Tab: onSelect fires AND preventDefault is called", () => {
    const onSelect = mock(() => {});
    const key = mockKey("tab");
    consumeSelectOverlayKey(key, { onClose: () => {}, onSelect });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(key.preventDefault).toHaveBeenCalledTimes(1);
  });

  test("Arrow keys: navigation fires AND preventDefault is called", () => {
    const onMoveUp = mock(() => {});
    const onMoveDown = mock(() => {});
    const up = mockKey("up");
    const down = mockKey("down");
    consumeSelectOverlayKey(up, { onClose: () => {}, onMoveUp });
    consumeSelectOverlayKey(down, { onClose: () => {}, onMoveDown });
    expect(onMoveUp).toHaveBeenCalledTimes(1);
    expect(onMoveDown).toHaveBeenCalledTimes(1);
    expect(up.preventDefault).toHaveBeenCalledTimes(1);
    expect(down.preventDefault).toHaveBeenCalledTimes(1);
  });

  test("Unconsumed key: preventDefault is NOT called", () => {
    const key = mockKey("a");
    const consumed = consumeSelectOverlayKey(key, { onClose: () => {} });
    expect(consumed).toBe(false);
    expect(key.preventDefault).toHaveBeenCalledTimes(0);
  });
});
