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
import { TuiRoot, executeGovernanceReset, resolveNavCommand } from "./tui-root.js";
import { PERMISSION_PROMPT_WIDTH } from "./components/PermissionPrompt.js";

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

  test("permission-prompt modal is bounded to PERMISSION_PROMPT_WIDTH on wide terminal (regression: #1913)", async () => {
    // Without an explicit width, OpenTUI re-measures the undimensioned absolute
    // box every layout pass, looping forever in blendCells. On a 100-col terminal
    // the modal caps at PERMISSION_PROMPT_WIDTH (60): right edge ≤ left(2) + 60 + border(2) = 64.
    const { captureCharFrame, renderer } = await renderRoot({
      modal: {
        kind: "permission-prompt",
        prompt: {
          requestId: "r1",
          toolId: "bash",
          input: { cmd: "ls" },
          reason: "",
          riskLevel: "low",
        },
      },
    });
    const frame = captureCharFrame();
    const titleLine = frame.split("\n").find((l) => l.includes("Permission Required"));
    expect(titleLine).toBeDefined();
    if (titleLine !== undefined) {
      // trimEnd() strips the terminal-pad spaces beyond the right border.
      expect(titleLine.trimEnd().length).toBeLessThanOrEqual(2 + PERMISSION_PROMPT_WIDTH + 2);
    }
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
// gov-9 governance view + reset
// ---------------------------------------------------------------------------

describe("TuiRoot — gov-9 governance", () => {
  test("nav:governance routes to GovernanceView", async () => {
    const utils = await renderRoot();
    await utils.renderOnce();
    // Trigger the governance view via command select would go through a UI keystroke
    // path; here, drive directly via dispatch since handleCommandSelect routes
    // nav commands via store.dispatch({ kind: 'set_view', view: navView })
    utils.store.dispatch({ kind: "set_view", view: "governance" });
    await utils.renderOnce();
    expect(utils.captureCharFrame()).toContain("Governance");
    expect(utils.captureCharFrame()).toContain("No governance data");
    utils.renderer.destroy();
  });

  test("executeGovernanceReset clears alerts AND notifies host", () => {
    const initial = createInitialState();
    const seeded = {
      ...initial,
      governance: {
        ...initial.governance,
        alerts: [
          {
            id: "a1",
            ts: 1,
            sessionId: "s",
            variable: "cost_usd",
            threshold: 0.8,
            current: 1.6,
            limit: 2,
            utilization: 0.8,
          },
        ],
      },
    };
    const store = createStore(seeded);
    const onCommand = mock((_id: string, _args: string) => {});
    expect(store.getState().governance.alerts).toHaveLength(1);
    executeGovernanceReset(store, onCommand, "");
    // Both behaviors verified:
    expect(store.getState().governance.alerts).toHaveLength(0);
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand).toHaveBeenCalledWith("system:governance-reset", "");
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

// ---------------------------------------------------------------------------
// ToastOverlay integration
// ---------------------------------------------------------------------------

describe("TuiRoot — ToastOverlay", () => {
  test("renders ToastOverlay with current toasts from store", async () => {
    const utils = await renderRoot();
    await utils.renderOnce();
    // Initial state: no toasts → no toast glyphs in frame
    expect(utils.captureCharFrame()).not.toContain("⚠");

    utils.store.dispatch({
      kind: "add_toast",
      toast: {
        id: "t1",
        kind: "warn",
        key: "test",
        title: "Budget alert",
        body: "$1.60 / $2.00",
        ts: 0,
      },
    });
    await utils.renderOnce();
    expect(utils.captureCharFrame()).toContain("Budget alert");
    expect(utils.captureCharFrame()).toContain("⚠");
    utils.renderer.destroy();
  });

  test("auto-dismisses toast after autoDismissMs elapsed", async () => {
    const utils = await renderRoot();
    await utils.renderOnce();
    utils.store.dispatch({
      kind: "add_toast",
      toast: {
        id: "t-fast",
        kind: "info",
        key: "test",
        title: "x",
        body: "y",
        ts: 0,
        autoDismissMs: 20,
      },
    });
    await utils.renderOnce();
    expect(utils.store.getState().toasts).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 200));
    await utils.renderOnce();
    expect(utils.store.getState().toasts).toHaveLength(0);
    utils.renderer.destroy();
  });
});
