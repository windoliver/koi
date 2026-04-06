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

/**
 * Counter-based callbacks — each returns a count accessor so tests can assert
 * exactly how many times each handler fired.
 */
function mockCallbacks(): {
  readonly onClose: () => void;
  readonly onSelect: () => void;
  readonly onMoveUp: () => void;
  readonly onMoveDown: () => void;
  readonly closeCount: () => number;
  readonly selectCount: () => number;
  readonly upCount: () => number;
  readonly downCount: () => number;
} {
  let closeCalls = 0;
  let selectCalls = 0;
  let upCalls = 0;
  let downCalls = 0;
  return {
    onClose: () => {
      closeCalls++;
    },
    onSelect: () => {
      selectCalls++;
    },
    onMoveUp: () => {
      upCalls++;
    },
    onMoveDown: () => {
      downCalls++;
    },
    closeCount: () => closeCalls,
    selectCount: () => selectCalls,
    upCount: () => upCalls,
    downCount: () => downCalls,
  };
}

// ---------------------------------------------------------------------------
// handleSelectOverlayKey
// ---------------------------------------------------------------------------

describe("handleSelectOverlayKey", () => {
  test("escape calls onClose and returns true", () => {
    const cb = mockCallbacks();
    const consumed = handleSelectOverlayKey(mockKey("escape"), cb);
    expect(consumed).toBe(true);
    expect(cb.closeCount()).toBe(1);
    expect(cb.selectCount()).toBe(0);
  });

  test("enter calls onSelect and returns true", () => {
    const cb = mockCallbacks();
    const consumed = handleSelectOverlayKey(mockKey("return"), cb);
    expect(consumed).toBe(true);
    expect(cb.selectCount()).toBe(1);
    expect(cb.closeCount()).toBe(0);
  });

  test("tab calls onSelect and returns true", () => {
    const cb = mockCallbacks();
    const consumed = handleSelectOverlayKey(mockKey("tab"), cb);
    expect(consumed).toBe(true);
    expect(cb.selectCount()).toBe(1);
  });

  test("up navigates and returns true", () => {
    const cb = mockCallbacks();
    const consumed = handleSelectOverlayKey(mockKey("up"), cb);
    expect(consumed).toBe(true);
    expect(cb.upCount()).toBe(1);
    expect(cb.selectCount()).toBe(0);
  });

  test("down navigates and returns true", () => {
    const cb = mockCallbacks();
    const consumed = handleSelectOverlayKey(mockKey("down"), cb);
    expect(consumed).toBe(true);
    expect(cb.downCount()).toBe(1);
    expect(cb.selectCount()).toBe(0);
  });

  test("Ctrl+P navigates up and returns true", () => {
    const cb = mockCallbacks();
    const consumed = handleSelectOverlayKey(mockKey("p", true), cb);
    expect(consumed).toBe(true);
    expect(cb.upCount()).toBe(1);
  });

  test("Ctrl+N navigates down and returns true", () => {
    const cb = mockCallbacks();
    const consumed = handleSelectOverlayKey(mockKey("n", true), cb);
    expect(consumed).toBe(true);
    expect(cb.downCount()).toBe(1);
  });

  test("printable characters are not consumed", () => {
    const cb = mockCallbacks();
    expect(handleSelectOverlayKey(mockKey("a"), cb)).toBe(false);
    expect(handleSelectOverlayKey(mockKey("1"), cb)).toBe(false);
    expect(cb.closeCount()).toBe(0);
    expect(cb.selectCount()).toBe(0);
  });

  test("optional handlers can be omitted without throwing", () => {
    const cb = { onClose: () => {} };
    expect(() => handleSelectOverlayKey(mockKey("return"), cb)).not.toThrow();
    expect(() => handleSelectOverlayKey(mockKey("up"), cb)).not.toThrow();
    expect(() => handleSelectOverlayKey(mockKey("down"), cb)).not.toThrow();
  });

  test("escape does not fire multiple times for a single call", () => {
    const cb = mockCallbacks();
    handleSelectOverlayKey(mockKey("escape"), cb);
    expect(cb.closeCount()).toBe(1);
  });

  test("unknown key returns false (not consumed)", () => {
    const cb = mockCallbacks();
    const consumed = handleSelectOverlayKey(mockKey("a"), cb);
    expect(consumed).toBe(false);
    expect(cb.closeCount()).toBe(0);
    expect(cb.selectCount()).toBe(0);
    expect(cb.upCount()).toBe(0);
    expect(cb.downCount()).toBe(0);
  });
});
