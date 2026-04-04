import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { processInputKey } from "./input-keys.js";

// ---------------------------------------------------------------------------
// Helpers — create mock KeyEvent objects
// ---------------------------------------------------------------------------

function key(
  name: string,
  mods?: {
    shift?: boolean;
    ctrl?: boolean;
    meta?: boolean;
    source?: "raw" | "kitty";
  },
): KeyEvent {
  return {
    name,
    shift: mods?.shift ?? false,
    ctrl: mods?.ctrl ?? false,
    meta: mods?.meta ?? false,
    option: false,
    number: false,
    sequence: name,
    raw: name,
    eventType: "press",
    source: mods?.source ?? "raw",
    preventDefault: () => {},
    stopPropagation: () => {},
    defaultPrevented: false,
    propagationStopped: false,
  } as KeyEvent;
}

function kittyKey(name: string, mods?: { shift?: boolean; ctrl?: boolean }): KeyEvent {
  return key(name, { ...mods, source: "kitty" });
}

// ---------------------------------------------------------------------------
// Enter / Submit (Kitty mode)
// ---------------------------------------------------------------------------

describe("processInputKey — Kitty mode", () => {
  test("Enter submits current text", () => {
    const result = processInputKey(kittyKey("return"), "hello");
    expect(result).toEqual({ kind: "submit", text: "hello" });
  });

  test("Shift+Enter inserts newline in Kitty mode", () => {
    const result = processInputKey(kittyKey("return", { shift: true }), "hello");
    expect(result).toEqual({ kind: "insert-newline" });
  });

  test("Enter submits even when text is multi-line", () => {
    const result = processInputKey(kittyKey("return"), "line1\nline2");
    expect(result).toEqual({ kind: "submit", text: "line1\nline2" });
  });

  test("Enter submits empty text", () => {
    const result = processInputKey(kittyKey("return"), "");
    expect(result).toEqual({ kind: "submit", text: "" });
  });
});

// ---------------------------------------------------------------------------
// Enter / Submit (Legacy/raw mode)
// ---------------------------------------------------------------------------

describe("processInputKey — Legacy mode", () => {
  test("Enter always submits in legacy mode", () => {
    const result = processInputKey(key("return"), "hello");
    expect(result).toEqual({ kind: "submit", text: "hello" });
  });

  test("Shift+Enter submits in legacy mode (can't distinguish)", () => {
    const result = processInputKey(key("return", { shift: true }), "hello");
    expect(result).toEqual({ kind: "submit", text: "hello" });
  });
});

// ---------------------------------------------------------------------------
// Ctrl+J — universal newline fallback
// ---------------------------------------------------------------------------

describe("processInputKey — Ctrl+J", () => {
  test("Ctrl+J inserts newline in Kitty mode", () => {
    const result = processInputKey(kittyKey("j", { ctrl: true }), "hello");
    expect(result).toEqual({ kind: "insert-newline" });
  });

  test("Ctrl+J inserts newline in legacy mode", () => {
    const result = processInputKey(key("j", { ctrl: true }), "hello");
    expect(result).toEqual({ kind: "insert-newline" });
  });
});

// ---------------------------------------------------------------------------
// Backspace / Delete
// ---------------------------------------------------------------------------

describe("processInputKey — backspace", () => {
  test("backspace deletes one character", () => {
    const result = processInputKey(key("backspace"), "hello");
    expect(result).toEqual({ kind: "backspace" });
  });

  test("Ctrl+backspace deletes word", () => {
    const result = processInputKey(key("backspace", { ctrl: true }), "hello world");
    expect(result).toEqual({ kind: "delete-word" });
  });
});

// ---------------------------------------------------------------------------
// Line editing
// ---------------------------------------------------------------------------

describe("processInputKey — line editing", () => {
  test("Ctrl+U clears line", () => {
    const result = processInputKey(key("u", { ctrl: true }), "hello");
    expect(result).toEqual({ kind: "clear-line" });
  });

  test("Ctrl+C submits empty (interrupt)", () => {
    const result = processInputKey(key("c", { ctrl: true }), "hello");
    expect(result).toEqual({ kind: "submit", text: "" });
  });
});

// ---------------------------------------------------------------------------
// History navigation
// ---------------------------------------------------------------------------

describe("processInputKey — history", () => {
  // History navigation is not yet implemented — up/down are always noop.
  test("up arrow is noop", () => {
    const result = processInputKey(key("up"), "");
    expect(result).toEqual({ kind: "noop" });
  });

  test("up arrow is noop when buffer is single-line", () => {
    const result = processInputKey(key("up"), "hello");
    expect(result).toEqual({ kind: "noop" });
  });

  test("up arrow is noop when buffer is multi-line", () => {
    const result = processInputKey(key("up"), "line1\nline2");
    expect(result).toEqual({ kind: "noop" });
  });

  test("down arrow is noop", () => {
    const result = processInputKey(key("down"), "");
    expect(result).toEqual({ kind: "noop" });
  });

  test("down arrow is noop when buffer is multi-line", () => {
    const result = processInputKey(key("down"), "line1\nline2");
    expect(result).toEqual({ kind: "noop" });
  });
});

// ---------------------------------------------------------------------------
// Tab / Escape / Noop
// ---------------------------------------------------------------------------

describe("processInputKey — special keys", () => {
  test("tab is noop (handled by slash overlay)", () => {
    const result = processInputKey(key("tab"), "");
    expect(result).toEqual({ kind: "noop" });
  });

  test("escape is noop (handled by parent)", () => {
    const result = processInputKey(key("escape"), "");
    expect(result).toEqual({ kind: "noop" });
  });

  test("printable characters are inserted", () => {
    const result = processInputKey(key("a"), "hell");
    expect(result).toEqual({ kind: "insert-char", char: "a" });
  });

  test("Ctrl+letter (not special) is noop", () => {
    const result = processInputKey(key("z", { ctrl: true }), "");
    expect(result).toEqual({ kind: "noop" });
  });

  test("unknown key names are noop", () => {
    const result = processInputKey(key("f12"), "");
    expect(result).toEqual({ kind: "noop" });
  });
});
