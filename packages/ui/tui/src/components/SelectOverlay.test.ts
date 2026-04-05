import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { handleSelectOverlayKey } from "./select-overlay-helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockKey(name: string, ctrl = false): KeyEvent {
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

  test("enter calls onSelect and returns true", () => {
    let selected = 0;
    const consumed = handleSelectOverlayKey(mockKey("return"), {
      onClose: () => {},
      onSelect: () => {
        selected++;
      },
    });
    expect(consumed).toBe(true);
    expect(selected).toBe(1);
  });

  test("tab calls onSelect and returns true", () => {
    let selected = 0;
    const consumed = handleSelectOverlayKey(mockKey("tab"), {
      onClose: () => {},
      onSelect: () => {
        selected++;
      },
    });
    expect(consumed).toBe(true);
    expect(selected).toBe(1);
  });

  test("up navigates and returns true", () => {
    let moved = 0;
    const consumed = handleSelectOverlayKey(mockKey("up"), {
      onClose: () => {},
      onMoveUp: () => {
        moved++;
      },
    });
    expect(consumed).toBe(true);
    expect(moved).toBe(1);
  });

  test("down navigates and returns true", () => {
    let moved = 0;
    const consumed = handleSelectOverlayKey(mockKey("down"), {
      onClose: () => {},
      onMoveDown: () => {
        moved++;
      },
    });
    expect(consumed).toBe(true);
    expect(moved).toBe(1);
  });

  test("Ctrl+P navigates up and returns true", () => {
    let moved = 0;
    const consumed = handleSelectOverlayKey(mockKey("p", true), {
      onClose: () => {},
      onMoveUp: () => {
        moved++;
      },
    });
    expect(consumed).toBe(true);
    expect(moved).toBe(1);
  });

  test("Ctrl+N navigates down and returns true", () => {
    let moved = 0;
    const consumed = handleSelectOverlayKey(mockKey("n", true), {
      onClose: () => {},
      onMoveDown: () => {
        moved++;
      },
    });
    expect(consumed).toBe(true);
    expect(moved).toBe(1);
  });

  test("printable characters are not consumed", () => {
    const cb = { onClose: () => {} };
    expect(handleSelectOverlayKey(mockKey("a"), cb)).toBe(false);
    expect(handleSelectOverlayKey(mockKey("1"), cb)).toBe(false);
  });

  test("optional handlers can be omitted without throwing", () => {
    const cb = { onClose: () => {} };
    expect(() => handleSelectOverlayKey(mockKey("return"), cb)).not.toThrow();
    expect(() => handleSelectOverlayKey(mockKey("up"), cb)).not.toThrow();
    expect(() => handleSelectOverlayKey(mockKey("down"), cb)).not.toThrow();
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
