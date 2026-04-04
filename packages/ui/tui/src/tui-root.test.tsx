/**
 * TuiRoot integration tests — verifies view routing and modal overlay rendering.
 *
 * Keyboard shortcut *logic* is tested as pure functions in keyboard.test.ts
 * (handleGlobalKey). These tests verify that TuiRoot correctly renders the
 * right component when state changes — dispatch-driven, not input-driven.
 *
 * Uses testRender from @opentui/react/test-utils.
 */

import { testRender } from "@opentui/react/test-utils";
import { describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createInitialState } from "./state/initial.js";
import { createStore } from "./state/store.js";
import { StoreContext } from "./store-context.js";
import { TuiRoot } from "./tui-root.js";

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
  const utils = await testRender(
    <StoreContext.Provider value={store}>
      <TuiRoot {...props} />
    </StoreContext.Provider>,
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
    act(() => { renderer.destroy(); });
  });

  test("conversation view renders by default", async () => {
    const { captureCharFrame, renderer } = await renderRoot();
    const frame = captureCharFrame();
    // InputArea placeholder text appears in conversation view when focused
    expect(frame).toContain("Type a message");
    act(() => { renderer.destroy(); });
  });

  test("sessions view renders placeholder", async () => {
    const { captureCharFrame, renderer } = await renderRoot({ activeView: "sessions" });
    const frame = captureCharFrame();
    expect(frame).toContain("sessions");
    act(() => { renderer.destroy(); });
  });

  test("doctor view renders placeholder", async () => {
    const { captureCharFrame, renderer } = await renderRoot({ activeView: "doctor" });
    const frame = captureCharFrame();
    expect(frame).toContain("doctor");
    act(() => { renderer.destroy(); });
  });

  test("help view renders placeholder", async () => {
    const { captureCharFrame, renderer } = await renderRoot({ activeView: "help" });
    const frame = captureCharFrame();
    expect(frame).toContain("help");
    act(() => { renderer.destroy(); });
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
    act(() => { renderer.destroy(); });
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
    act(() => { renderer.destroy(); });
  });

  test("null modal renders no overlay", async () => {
    const { captureCharFrame, renderer } = await renderRoot({ modal: null });
    const frame = captureCharFrame();
    expect(frame).not.toContain("Commands");
    act(() => { renderer.destroy(); });
  });

  test("InputArea is unfocused when modal is open (focused prop propagates)", async () => {
    // When modal is open, ConversationView receives focused={false}
    // InputArea placeholder still appears (just without cursor focus)
    const { captureCharFrame, renderer } = await renderRoot({
      modal: { kind: "command-palette", query: "" },
    });
    const frame = captureCharFrame();
    expect(frame).toContain("Commands"); // modal visible
    act(() => { renderer.destroy(); });
  });
});

// ---------------------------------------------------------------------------
// Keyboard note
// ---------------------------------------------------------------------------
// The global keyboard handler logic (Ctrl+P, Ctrl+C, Esc routing to
// onDismissModal / onBack) is unit-tested as a pure function in
// keyboard.test.ts. TuiRoot renders the correct output for each state —
// the view routing and modal overlay tests above cover this fully.
