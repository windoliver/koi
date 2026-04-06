/**
 * Keyboard handler tests for the slash overlay.
 *
 * `handleSelectOverlayKey` (formerly `handleSlashOverlayKey`) was extracted to
 * select-overlay-helpers.ts during the DRY scroll primitive refactor so it can
 * be reused by SelectOverlay and SlashOverlay alike. Tests live here to
 * preserve the test-file-per-component convention and keep coverage in place.
 */

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

function mockCallbacks(): {
  readonly onSelect: () => void;
  readonly onClose: () => void;
  readonly onMoveUp: () => void;
  readonly onMoveDown: () => void;
  readonly selectCount: () => number;
  readonly closeCount: () => number;
  readonly upCount: () => number;
  readonly downCount: () => number;
} {
  let selectCalls = 0;
  let closeCalls = 0;
  let upCalls = 0;
  let downCalls = 0;
  return {
    onSelect: () => {
      selectCalls++;
    },
    onClose: () => {
      closeCalls++;
    },
    onMoveUp: () => {
      upCalls++;
    },
    onMoveDown: () => {
      downCalls++;
    },
    selectCount: () => selectCalls,
    closeCount: () => closeCalls,
    upCount: () => upCalls,
    downCount: () => downCalls,
  };
}

// ---------------------------------------------------------------------------
// handleSelectOverlayKey
// ---------------------------------------------------------------------------

describe("handleSelectOverlayKey", () => {
  test("escape closes and returns true", () => {
    const cb = mockCallbacks();
    const consumed = handleSelectOverlayKey(mockKey("escape"), cb);
    expect(consumed).toBe(true);
    expect(cb.closeCount()).toBe(1);
    expect(cb.selectCount()).toBe(0);
  });

  test("return selects and returns true", () => {
    const cb = mockCallbacks();
    const consumed = handleSelectOverlayKey(mockKey("return"), cb);
    expect(consumed).toBe(true);
    expect(cb.selectCount()).toBe(1);
    expect(cb.closeCount()).toBe(0);
  });

  test("tab selects and returns true", () => {
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

  test("unknown key returns false (not consumed)", () => {
    const cb = mockCallbacks();
    const consumed = handleSelectOverlayKey(mockKey("a"), cb);
    expect(consumed).toBe(false);
    expect(cb.selectCount()).toBe(0);
    expect(cb.closeCount()).toBe(0);
    expect(cb.upCount()).toBe(0);
    expect(cb.downCount()).toBe(0);
  });

  test("optional onSelect/onMoveUp/onMoveDown can be omitted", () => {
    // Passing only the required onClose must not throw on nav/select keys
    const base = { onClose: () => {} };
    expect(() => handleSelectOverlayKey(mockKey("up"), base)).not.toThrow();
    expect(() => handleSelectOverlayKey(mockKey("down"), base)).not.toThrow();
    expect(() => handleSelectOverlayKey(mockKey("return"), base)).not.toThrow();
  });
});
