import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { handleSlashOverlayKey } from "./SlashOverlay.js";

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

function mockCallbacks(): {
  readonly onSelect: () => void;
  readonly onDismiss: () => void;
  readonly selectCount: () => number;
  readonly dismissCount: () => number;
} {
  let selectCalls = 0;
  let dismissCalls = 0;
  return {
    onSelect: () => {
      selectCalls++;
    },
    onDismiss: () => {
      dismissCalls++;
    },
    selectCount: () => selectCalls,
    dismissCount: () => dismissCalls,
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

  test("unknown key returns false (not consumed)", () => {
    const cb = mockCallbacks();
    const consumed = handleSlashOverlayKey(mockKey("a"), cb);
    expect(consumed).toBe(false);
    expect(cb.selectCount()).toBe(0);
    expect(cb.dismissCount()).toBe(0);
  });

  test("arrow keys are not consumed (handled by <select>)", () => {
    const cb = mockCallbacks();
    expect(handleSlashOverlayKey(mockKey("up"), cb)).toBe(false);
    expect(handleSlashOverlayKey(mockKey("down"), cb)).toBe(false);
  });
});
