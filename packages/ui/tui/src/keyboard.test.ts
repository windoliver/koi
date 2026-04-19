/**
 * keyboard.ts unit tests — Decision 9A: pure function tested without React.
 *
 * All tests call handleGlobalKey() directly with mock KeyEvents and
 * a stub TuiState, then assert on callback invocations and return values.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import type { GlobalKeyCallbacks } from "./keyboard.js";
import { createKeyboardHandler, handleGlobalKey } from "./keyboard.js";
import { createInitialState } from "./state/initial.js";
import { createStore } from "./state/store.js";
import type { TuiState } from "./state/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function key(name: string, mods?: { ctrl?: boolean; shift?: boolean }): KeyEvent {
  return {
    name,
    ctrl: mods?.ctrl ?? false,
    shift: mods?.shift ?? false,
    meta: false,
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

function makeCallbacks(): GlobalKeyCallbacks {
  return {
    onTogglePalette: mock(() => {}),
    onInterrupt: mock(() => {}),
    onDismissModal: mock(() => {}),
    onBack: mock(() => {}),
    onNewSession: mock(() => {}),
  };
}

const stateNoModal: TuiState = createInitialState();
const stateWithModal: TuiState = {
  ...createInitialState(),
  modal: { kind: "command-palette", query: "" },
};

// ---------------------------------------------------------------------------
// handleGlobalKey — Ctrl+P
// ---------------------------------------------------------------------------

describe("handleGlobalKey — Ctrl+P", () => {
  test("calls onTogglePalette and returns true", () => {
    const cbs = makeCallbacks();
    const result = handleGlobalKey(key("p", { ctrl: true }), stateNoModal, cbs);
    expect(result).toBe(true);
    expect(cbs.onTogglePalette).toHaveBeenCalledTimes(1);
    expect(cbs.onInterrupt).not.toHaveBeenCalled();
    expect(cbs.onDismissModal).not.toHaveBeenCalled();
    expect(cbs.onBack).not.toHaveBeenCalled();
  });

  test("calls onTogglePalette even when palette is already open", () => {
    const cbs = makeCallbacks();
    handleGlobalKey(key("p", { ctrl: true }), stateWithModal, cbs);
    expect(cbs.onTogglePalette).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// handleGlobalKey — Ctrl+N
// ---------------------------------------------------------------------------

describe("handleGlobalKey — Ctrl+N", () => {
  test("calls onNewSession on conversation view with no modal", () => {
    const cbs = makeCallbacks();
    const result = handleGlobalKey(key("n", { ctrl: true }), stateNoModal, cbs);
    expect(result).toBe(true);
    expect(cbs.onNewSession).toHaveBeenCalledTimes(1);
    expect(cbs.onTogglePalette).not.toHaveBeenCalled();
  });

  test("ignored when a modal is open (select overlay uses Ctrl+N as down)", () => {
    const cbs = makeCallbacks();
    const result = handleGlobalKey(key("n", { ctrl: true }), stateWithModal, cbs);
    expect(result).toBe(false);
    expect(cbs.onNewSession).not.toHaveBeenCalled();
  });

  test("ignored on non-conversation views (TrajectoryView uses Ctrl+N as down)", () => {
    const state: TuiState = { ...createInitialState(), activeView: "trajectory" };
    const cbs = makeCallbacks();
    const result = handleGlobalKey(key("n", { ctrl: true }), state, cbs);
    expect(result).toBe(false);
    expect(cbs.onNewSession).not.toHaveBeenCalled();
  });

  test("ignored when slash overlay is active (Ctrl+N navigates slash commands)", () => {
    const state: TuiState = { ...createInitialState(), slashQuery: "ses" };
    const cbs = makeCallbacks();
    const result = handleGlobalKey(key("n", { ctrl: true }), state, cbs);
    expect(result).toBe(false);
    expect(cbs.onNewSession).not.toHaveBeenCalled();
  });

  test("ignored when @-mention overlay is active (Ctrl+N navigates file completions)", () => {
    const state: TuiState = { ...createInitialState(), atQuery: "src/" };
    const cbs = makeCallbacks();
    const result = handleGlobalKey(key("n", { ctrl: true }), state, cbs);
    expect(result).toBe(false);
    expect(cbs.onNewSession).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleGlobalKey — Ctrl+C
// ---------------------------------------------------------------------------

describe("handleGlobalKey — Ctrl+C", () => {
  test("calls onInterrupt and returns true", () => {
    const cbs = makeCallbacks();
    const result = handleGlobalKey(key("c", { ctrl: true }), stateNoModal, cbs);
    expect(result).toBe(true);
    expect(cbs.onInterrupt).toHaveBeenCalledTimes(1);
    expect(cbs.onTogglePalette).not.toHaveBeenCalled();
  });

  test("calls onInterrupt even when a modal is open", () => {
    const cbs = makeCallbacks();
    handleGlobalKey(key("c", { ctrl: true }), stateWithModal, cbs);
    expect(cbs.onInterrupt).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// handleGlobalKey — Escape
// ---------------------------------------------------------------------------

describe("handleGlobalKey — Escape", () => {
  test("calls onDismissModal when modal is open, returns true", () => {
    const cbs = makeCallbacks();
    const result = handleGlobalKey(key("escape"), stateWithModal, cbs);
    expect(result).toBe(true);
    expect(cbs.onDismissModal).toHaveBeenCalledTimes(1);
    expect(cbs.onBack).not.toHaveBeenCalled();
  });

  test("calls onBack when no modal is open, returns true", () => {
    const cbs = makeCallbacks();
    const result = handleGlobalKey(key("escape"), stateNoModal, cbs);
    expect(result).toBe(true);
    expect(cbs.onBack).toHaveBeenCalledTimes(1);
    expect(cbs.onDismissModal).not.toHaveBeenCalled();
  });

  test("Esc with permission-prompt modal → dismisses modal", () => {
    const state: TuiState = {
      ...createInitialState(),
      modal: {
        kind: "permission-prompt",
        prompt: {
          requestId: "r1",
          toolId: "bash",
          input: {},
          reason: "test",
          riskLevel: "medium",
        },
      },
    };
    const cbs = makeCallbacks();
    handleGlobalKey(key("escape"), state, cbs);
    expect(cbs.onDismissModal).toHaveBeenCalledTimes(1);
  });

  test("Esc while agent is processing → interrupts (beats modal/back)", () => {
    const state: TuiState = { ...createInitialState(), agentStatus: "processing" };
    const cbs = makeCallbacks();
    handleGlobalKey(key("escape"), state, cbs);
    expect(cbs.onInterrupt).toHaveBeenCalledTimes(1);
    expect(cbs.onDismissModal).not.toHaveBeenCalled();
    expect(cbs.onBack).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleGlobalKey — unhandled keys
// ---------------------------------------------------------------------------

describe("handleGlobalKey — unhandled keys", () => {
  let cbs: GlobalKeyCallbacks;

  beforeEach(() => {
    cbs = makeCallbacks();
  });

  test("plain letter returns false, no callbacks", () => {
    expect(handleGlobalKey(key("a"), stateNoModal, cbs)).toBe(false);
    expect(cbs.onTogglePalette).not.toHaveBeenCalled();
    expect(cbs.onInterrupt).not.toHaveBeenCalled();
    expect(cbs.onDismissModal).not.toHaveBeenCalled();
    expect(cbs.onBack).not.toHaveBeenCalled();
  });

  test("return key returns false", () => {
    expect(handleGlobalKey(key("return"), stateNoModal, cbs)).toBe(false);
  });

  test("ctrl+u returns false", () => {
    expect(handleGlobalKey(key("u", { ctrl: true }), stateNoModal, cbs)).toBe(false);
  });

  test("arrow keys return false", () => {
    expect(handleGlobalKey(key("up"), stateNoModal, cbs)).toBe(false);
    expect(handleGlobalKey(key("down"), stateNoModal, cbs)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createKeyboardHandler
// ---------------------------------------------------------------------------

describe("createKeyboardHandler", () => {
  test("returns a function that delegates to handleGlobalKey with live state", () => {
    const store = createStore(createInitialState());
    const cbs = makeCallbacks();
    const handler = createKeyboardHandler(store, cbs);

    // No modal initially — Esc should call onBack
    handler(key("escape"));
    expect(cbs.onBack).toHaveBeenCalledTimes(1);
    expect(cbs.onDismissModal).not.toHaveBeenCalled();
  });

  test("reads state at event-time (not at creation-time)", () => {
    const store = createStore(createInitialState());
    const cbs = makeCallbacks();
    const handler = createKeyboardHandler(store, cbs);

    // Open a modal after creating the handler
    store.dispatch({ kind: "set_modal", modal: { kind: "command-palette", query: "" } });

    // Now Esc should call onDismissModal, not onBack
    handler(key("escape"));
    expect(cbs.onDismissModal).toHaveBeenCalledTimes(1);
    expect(cbs.onBack).not.toHaveBeenCalled();
  });
});
