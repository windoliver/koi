import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import {
  isBackspace,
  isCtrlC,
  isCtrlJ,
  isCtrlN,
  isCtrlP,
  isEnter,
  isEscape,
  isTab,
} from "./key-event.js";

// ---------------------------------------------------------------------------
// Mock factory — mirrors input-keys.test.ts pattern
// ---------------------------------------------------------------------------

function key(name: string, mods?: { ctrl?: boolean; shift?: boolean; meta?: boolean }): KeyEvent {
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
    source: "raw",
    preventDefault: () => {},
    stopPropagation: () => {},
    defaultPrevented: false,
    propagationStopped: false,
  } as KeyEvent;
}

// ---------------------------------------------------------------------------
// isEscape
// ---------------------------------------------------------------------------

describe("isEscape", () => {
  test("true for escape key", () => {
    expect(isEscape(key("escape"))).toBe(true);
  });

  test("false for other keys", () => {
    expect(isEscape(key("return"))).toBe(false);
    expect(isEscape(key("e"))).toBe(false);
    expect(isEscape(key("c", { ctrl: true }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isEnter
// ---------------------------------------------------------------------------

describe("isEnter", () => {
  test("true for return key", () => {
    expect(isEnter(key("return"))).toBe(true);
  });

  test("false for escape or printable", () => {
    expect(isEnter(key("escape"))).toBe(false);
    expect(isEnter(key("n"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isCtrlC
// ---------------------------------------------------------------------------

describe("isCtrlC", () => {
  test("true for ctrl+c", () => {
    expect(isCtrlC(key("c", { ctrl: true }))).toBe(true);
  });

  test("false for plain c", () => {
    expect(isCtrlC(key("c"))).toBe(false);
  });

  test("false for ctrl+other", () => {
    expect(isCtrlC(key("p", { ctrl: true }))).toBe(false);
    expect(isCtrlC(key("u", { ctrl: true }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isCtrlP
// ---------------------------------------------------------------------------

describe("isCtrlP", () => {
  test("true for ctrl+p", () => {
    expect(isCtrlP(key("p", { ctrl: true }))).toBe(true);
  });

  test("false for plain p", () => {
    expect(isCtrlP(key("p"))).toBe(false);
  });

  test("false for ctrl+c", () => {
    expect(isCtrlP(key("c", { ctrl: true }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isCtrlN
// ---------------------------------------------------------------------------

describe("isCtrlN", () => {
  test("true for ctrl+n", () => {
    expect(isCtrlN(key("n", { ctrl: true }))).toBe(true);
  });

  test("false for plain n", () => {
    expect(isCtrlN(key("n"))).toBe(false);
  });

  test("false for ctrl+p", () => {
    expect(isCtrlN(key("p", { ctrl: true }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isCtrlJ
// ---------------------------------------------------------------------------

describe("isCtrlJ", () => {
  test("true for ctrl+j", () => {
    expect(isCtrlJ(key("j", { ctrl: true }))).toBe(true);
  });

  test("false for plain j", () => {
    expect(isCtrlJ(key("j"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isBackspace
// ---------------------------------------------------------------------------

describe("isBackspace", () => {
  test("true for backspace key", () => {
    expect(isBackspace(key("backspace"))).toBe(true);
  });

  test("false for delete or other", () => {
    expect(isBackspace(key("delete"))).toBe(false);
    expect(isBackspace(key("b"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isTab
// ---------------------------------------------------------------------------

describe("isTab", () => {
  test("true for tab key", () => {
    expect(isTab(key("tab"))).toBe(true);
  });

  test("false for return or space", () => {
    expect(isTab(key("return"))).toBe(false);
    expect(isTab(key(" "))).toBe(false);
  });
});
