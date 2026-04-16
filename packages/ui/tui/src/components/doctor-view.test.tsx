/**
 * DoctorView tests — written before implementation (test-first).
 */

import { testRender } from "@opentui/solid";
import { describe, expect, mock, test } from "bun:test";
import { createInitialState } from "../state/initial.js";
import { createStore } from "../state/store.js";
import type { SessionInfo } from "../state/types.js";
import { StoreContext } from "../store-context.js";
import { TuiRoot } from "../tui-root.js";

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

async function renderDoctorView(
  overrides?: Partial<{ connectionStatus: "connected" | "disconnected" | "reconnecting"; sessionInfo: SessionInfo | null }>,
) {
  const state = { ...createInitialState(), activeView: "doctor" as const, ...overrides };
  const store = createStore(state);
  const props = makeProps();
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

describe("DoctorView", () => {
  test("renders System Health heading", async () => {
    const { captureCharFrame, renderer } = await renderDoctorView();
    const frame = captureCharFrame();
    expect(frame).toContain("System Health");
    renderer.destroy();
  });

  test("shows disconnected connection status", async () => {
    const { captureCharFrame, renderer } = await renderDoctorView({ connectionStatus: "disconnected" });
    const frame = captureCharFrame();
    expect(frame).toContain("disconnected");
    renderer.destroy();
  });

  test("shows connected connection status", async () => {
    const { captureCharFrame, renderer } = await renderDoctorView({ connectionStatus: "connected" });
    const frame = captureCharFrame();
    expect(frame).toContain("connected");
    renderer.destroy();
  });

  test("shows model name when session is active", async () => {
    const sessionInfo: SessionInfo = {
      modelName: "claude-opus-4-6",
      provider: "anthropic",
      sessionName: "test",
      sessionId: "test-sid",
    };
    const { captureCharFrame, renderer } = await renderDoctorView({ sessionInfo });
    const frame = captureCharFrame();
    expect(frame).toContain("claude-opus-4-6");
    renderer.destroy();
  });

  test("shows dash placeholders when no session is active", async () => {
    const { captureCharFrame, renderer } = await renderDoctorView({ sessionInfo: null });
    const frame = captureCharFrame();
    expect(frame).toContain("—");
    renderer.destroy();
  });

  test("#1753: renders connected + populated model/provider after a successful turn", async () => {
    // Regression for bug-bash S11/Q60: immediately after a successful
    // model turn, /doctor must reflect the live runtime state — not a
    // stale "disconnected" placeholder with blank Model/Provider.
    const sessionInfo: SessionInfo = {
      modelName: "anthropic/claude-sonnet-4.5",
      provider: "openrouter",
      sessionName: "",
      sessionId: "sid-1753",
    };
    const { captureCharFrame, renderer } = await renderDoctorView({
      connectionStatus: "connected",
      sessionInfo,
    });
    const frame = captureCharFrame();
    expect(frame).toContain("connected");
    expect(frame).not.toContain("disconnected");
    expect(frame).toContain("anthropic/claude-sonnet-4.5");
    expect(frame).toContain("openrouter");
    renderer.destroy();
  });
});
