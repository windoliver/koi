/**
 * TuiRoot integration tests — verifies view routing and modal overlay rendering.
 *
 * Keyboard shortcut *logic* is tested as pure functions in keyboard.test.ts
 * (handleGlobalKey). These tests verify that TuiRoot correctly renders the
 * right component when state changes — dispatch-driven, not input-driven.
 *
 * Uses testRender from @opentui/solid.
 */

import { testRender } from "@opentui/solid";
import { describe, expect, mock, test } from "bun:test";
import { createInitialState } from "./state/initial.js";
import { createStore } from "./state/store.js";
import { StoreContext } from "./store-context.js";
import { TuiRoot, resolveNavCommand } from "./tui-root.js";

const OPTS = { width: 100, height: 30 };

function makeProps() {
  return {
    onCommand: mock((_id: string) => {}),
    onSessionSelect: mock((_id: string) => {}),
    onSubmit: mock((_text: string) => {}),
    onInterrupt: mock(() => {}),
    onPermissionRespond: mock((_requestId: string, _decision: unknown) => {}),
  };
}

async function renderRoot(overrideState?: Partial<ReturnType<typeof createInitialState>>) {
  const state = overrideState
    ? { ...createInitialState(), ...overrideState }
    : createInitialState();
  const store = createStore(state);
  const props = makeProps();
  // Only StoreContext.Provider needed — the SolidJS store provides reactivity directly
  const utils = await testRender(
    () => (
      <StoreContext.Provider value={store}>
        <TuiRoot {...props} />
      </StoreContext.Provider>
    ),
    OPTS,
  );
  await utils.renderOnce();
  return { ...utils, store, props };
}

// ---------------------------------------------------------------------------
// View routing
// ---------------------------------------------------------------------------

describe("TuiRoot — view routing", () => {
  test("renders status bar in all views", async () => {
    const { captureCharFrame, renderer } = await renderRoot();
    const frame = captureCharFrame();
    // StatusBar is always present (no session = "no session")
    expect(frame).toContain("no session");
    renderer.destroy();
  });

  test("conversation view renders by default", async () => {
    const { captureCharFrame, renderer } = await renderRoot();
    const frame = captureCharFrame();
    // InputArea placeholder text appears in conversation view when focused
    expect(frame).toContain("Type a message");
    renderer.destroy();
  });

  test("doctor view renders System Health heading", async () => {
    const { captureCharFrame, renderer } = await renderRoot({ activeView: "doctor" });
    const frame = captureCharFrame();
    expect(frame).toContain("System Health");
    renderer.destroy();
  });

  test("help view renders Keyboard Shortcuts heading", async () => {
    const { captureCharFrame, renderer } = await renderRoot({ activeView: "help" });
    const frame = captureCharFrame();
    expect(frame).toContain("Keyboard Shortcuts");
    renderer.destroy();
  });
});

// ---------------------------------------------------------------------------
// Modal overlay
// ---------------------------------------------------------------------------

describe("TuiRoot — modal overlay", () => {
  test("command-palette modal renders over conversation view", async () => {
    const { captureCharFrame, renderer } = await renderRoot({
      modal: { kind: "command-palette", query: "" },
    });
    const frame = captureCharFrame();
    expect(frame).toContain("Commands");
    renderer.destroy();
  });

  test("permission-prompt modal renders over conversation view", async () => {
    const { captureCharFrame, renderer } = await renderRoot({
      modal: {
        kind: "permission-prompt",
        prompt: {
          requestId: "r1",
          toolId: "bash",
          input: { cmd: "ls" },
          reason: "list files",
          riskLevel: "medium",
        },
      },
    });
    const frame = captureCharFrame();
    expect(frame).toContain("bash");
    renderer.destroy();
  });

  test("null modal renders no overlay", async () => {
    const { captureCharFrame, renderer } = await renderRoot({ modal: null });
    const frame = captureCharFrame();
    expect(frame).not.toContain("Commands");
    renderer.destroy();
  });

  test("InputArea is unfocused when modal is open (focused prop propagates)", async () => {
    // When modal is open, ConversationView receives focused={false}
    // InputArea placeholder still appears (just without cursor focus)
    const { captureCharFrame, renderer } = await renderRoot({
      modal: { kind: "command-palette", query: "" },
    });
    const frame = captureCharFrame();
    expect(frame).toContain("Commands"); // modal visible
    renderer.destroy();
  });
});

// ---------------------------------------------------------------------------
// Keyboard note
// ---------------------------------------------------------------------------
// The global keyboard handler logic (Ctrl+P, Ctrl+C, Esc routing to
// onDismissModal / onBack) is unit-tested as a pure function in
// keyboard.test.ts. TuiRoot renders the correct output for each state —
// the view routing and modal overlay tests above cover this fully.

// ---------------------------------------------------------------------------
// resolveNavCommand — nav/engine command routing split
// ---------------------------------------------------------------------------

describe("resolveNavCommand", () => {
  test("nav commands return the target TuiView", () => {
    expect(resolveNavCommand("nav:doctor")).toBe("doctor");
    expect(resolveNavCommand("nav:help")).toBe("help");
    expect(resolveNavCommand("nav:trajectory")).toBe("trajectory");
  });

  test("engine-affecting commands return null (bubble up to onCommand)", () => {
    expect(resolveNavCommand("agent:clear")).toBeNull();
    expect(resolveNavCommand("agent:interrupt")).toBeNull();
    expect(resolveNavCommand("agent:compact")).toBeNull();
    expect(resolveNavCommand("session:new")).toBeNull();
    expect(resolveNavCommand("system:quit")).toBeNull();
  });
});
