import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { handleSlashOverlayKey } from "./SlashOverlay.js";

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

function mockCallbacks(): {
  readonly onSelect: () => void;
  readonly onDismiss: () => void;
  readonly onMoveUp: () => void;
  readonly onMoveDown: () => void;
  readonly selectCount: () => number;
  readonly dismissCount: () => number;
  readonly upCount: () => number;
  readonly downCount: () => number;
} {
  let selectCalls = 0;
  let dismissCalls = 0;
  let upCalls = 0;
  let downCalls = 0;
  return {
    onSelect: () => {
      selectCalls++;
    },
    onDismiss: () => {
      dismissCalls++;
    },
    onMoveUp: () => {
      upCalls++;
    },
    onMoveDown: () => {
      downCalls++;
    },
    selectCount: () => selectCalls,
    dismissCount: () => dismissCalls,
    upCount: () => upCalls,
    downCount: () => downCalls,
  };
}

// ---------------------------------------------------------------------------
// handleSlashOverlayKey
// ---------------------------------------------------------------------------

describe("handleSlashOverlayKey", () => {
  test("escape dismisses and returns true", () => {
    const cb = mockCallbacks();
    const consumed = handleSlashOverlayKey(mockKey("escape"), cb);
    expect(consumed).toBe(true);
    expect(cb.dismissCount()).toBe(1);
    expect(cb.selectCount()).toBe(0);
  });

  test("return selects and returns true", () => {
    const cb = mockCallbacks();
    const consumed = handleSlashOverlayKey(mockKey("return"), cb);
    expect(consumed).toBe(true);
    expect(cb.selectCount()).toBe(1);
    expect(cb.dismissCount()).toBe(0);
  });

  test("tab selects and returns true", () => {
    const cb = mockCallbacks();
    const consumed = handleSlashOverlayKey(mockKey("tab"), cb);
    expect(consumed).toBe(true);
    expect(cb.selectCount()).toBe(1);
  });

  test("up navigates and returns true", () => {
    const cb = mockCallbacks();
    const consumed = handleSlashOverlayKey(mockKey("up"), cb);
    expect(consumed).toBe(true);
    expect(cb.upCount()).toBe(1);
    expect(cb.selectCount()).toBe(0);
  });

  test("down navigates and returns true", () => {
    const cb = mockCallbacks();
    const consumed = handleSlashOverlayKey(mockKey("down"), cb);
    expect(consumed).toBe(true);
    expect(cb.downCount()).toBe(1);
    expect(cb.selectCount()).toBe(0);
  });

  test("Ctrl+P navigates up and returns true", () => {
    const cb = mockCallbacks();
    const consumed = handleSlashOverlayKey(mockKey("p", true), cb);
    expect(consumed).toBe(true);
    expect(cb.upCount()).toBe(1);
  });

  test("Ctrl+N navigates down and returns true", () => {
    const cb = mockCallbacks();
    const consumed = handleSlashOverlayKey(mockKey("n", true), cb);
    expect(consumed).toBe(true);
    expect(cb.downCount()).toBe(1);
  });

  test("unknown key returns false (not consumed)", () => {
    const cb = mockCallbacks();
    const consumed = handleSlashOverlayKey(mockKey("a"), cb);
    expect(consumed).toBe(false);
    expect(cb.selectCount()).toBe(0);
    expect(cb.dismissCount()).toBe(0);
    expect(cb.upCount()).toBe(0);
    expect(cb.downCount()).toBe(0);
  });

  test("optional onMoveUp/onMoveDown can be omitted", () => {
    // Passing callbacks without navigation handlers must not throw
    const base = { onSelect: () => {}, onDismiss: () => {} };
    expect(() => handleSlashOverlayKey(mockKey("up"), base)).not.toThrow();
    expect(() => handleSlashOverlayKey(mockKey("down"), base)).not.toThrow();
  });
});
