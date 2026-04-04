import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { handleSelectOverlayKey } from "./select-overlay-helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockKey(name: string): KeyEvent {
  return {
    name,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: name,
    raw: name,
    eventType: "press",
    source: "raw",
    preventDefault: () => {},
    stopPropagation: () => {},
    defaultPrevented: false,
    propagationStopped: false,
  } as KeyEvent;
}

// ---------------------------------------------------------------------------
// handleSelectOverlayKey
// ---------------------------------------------------------------------------

describe("handleSelectOverlayKey", () => {
  test("escape calls onClose and returns true", () => {
    let closed = 0;
    const consumed = handleSelectOverlayKey(mockKey("escape"), {
      onClose: () => {
        closed++;
      },
    });
    expect(consumed).toBe(true);
    expect(closed).toBe(1);
  });

  test("arrow keys are NOT consumed (handled by <select>)", () => {
    const cb = { onClose: () => {} };
    expect(handleSelectOverlayKey(mockKey("up"), cb)).toBe(false);
    expect(handleSelectOverlayKey(mockKey("down"), cb)).toBe(false);
  });

  test("enter is NOT consumed (handled by <select>)", () => {
    const cb = { onClose: () => {} };
    expect(handleSelectOverlayKey(mockKey("return"), cb)).toBe(false);
  });

  test("printable characters are NOT consumed", () => {
    const cb = { onClose: () => {} };
    expect(handleSelectOverlayKey(mockKey("a"), cb)).toBe(false);
    expect(handleSelectOverlayKey(mockKey("1"), cb)).toBe(false);
  });

  test("escape does not fire multiple times for a single call", () => {
    let closed = 0;
    handleSelectOverlayKey(mockKey("escape"), {
      onClose: () => {
        closed++;
      },
    });
    expect(closed).toBe(1);
  });
});
