/**
 * SessionsView tests — written before implementation (test-first).
 *
 * Rendered through TuiRoot with activeView="sessions" to exercise the full
 * context chain (StoreContext → TuiStateContext → useTuiStore).
 */

import { testRender } from "@opentui/solid";
import { describe, expect, mock, test } from "bun:test";
import { createInitialState } from "../state/initial.js";
import { createStore } from "../state/store.js";
import type { SessionSummary } from "../state/types.js";
import { StoreContext } from "../store-context.js";
import { TuiRoot } from "../tui-root.js";

const OPTS = { width: 100, height: 30 };

const SESSION_A: SessionSummary = {
  id: "s1",
  name: "My project",
  lastActivityAt: Date.now() - 60_000,
  messageCount: 5,
  preview: "Tell me about the codebase",
};
const SESSION_B: SessionSummary = {
  id: "s2",
  name: "Debug session",
  lastActivityAt: Date.now() - 3_600_000,
  messageCount: 12,
  preview: "Fix the test failures",
};

function makeProps() {
  return {
    onCommand: mock((_id: string) => {}),
    onSessionSelect: mock((_id: string) => {}),
    onSubmit: mock((_text: string) => {}),
    onInterrupt: mock(() => {}),
    onPermissionRespond: mock((_requestId: string, _decision: unknown) => {}),
  };
}

async function renderSessionsView(sessions: readonly SessionSummary[]) {
  const state = { ...createInitialState(), activeView: "sessions" as const, sessions };
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

describe("SessionsView", () => {
  test("shows empty state when no sessions", async () => {
    const { captureCharFrame, renderer } = await renderSessionsView([]);
    const frame = captureCharFrame();
    expect(frame).toContain("No saved sessions");
    renderer.destroy();
  });

  test("renders session names when sessions exist", async () => {
    const { captureCharFrame, renderer } = await renderSessionsView([SESSION_A, SESSION_B]);
    const frame = captureCharFrame();
    expect(frame).toContain("My project");
    expect(frame).toContain("Debug session");
    renderer.destroy();
  });

  test("renders session preview text", async () => {
    const { captureCharFrame, renderer } = await renderSessionsView([SESSION_A]);
    const frame = captureCharFrame();
    expect(frame).toContain("Tell me about the codebase");
    renderer.destroy();
  });

  test("renders Sessions heading", async () => {
    const { captureCharFrame, renderer } = await renderSessionsView([]);
    const frame = captureCharFrame();
    expect(frame).toContain("Sessions");
    renderer.destroy();
  });
});
