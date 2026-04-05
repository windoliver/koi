/**
 * HelpView tests — written before implementation (test-first).
 *
 * HelpView is static — no store reads. Tests render through TuiRoot for
 * consistency with the other view tests.
 */

import { testRender } from "@opentui/solid";
import { describe, expect, mock, test } from "bun:test";
import { COMMAND_DEFINITIONS } from "../commands/command-definitions.js";
import { createInitialState } from "../state/initial.js";
import { createStore } from "../state/store.js";
import { StoreContext } from "../store-context.js";
import { TuiRoot } from "../tui-root.js";

const OPTS = { width: 120, height: 40 };

function makeProps() {
  return {
    onCommand: mock((_id: string) => {}),
    onSessionSelect: mock((_id: string) => {}),
    onSubmit: mock((_text: string) => {}),
    onInterrupt: mock(() => {}),
    onPermissionRespond: mock((_requestId: string, _decision: unknown) => {}),
  };
}

async function renderHelpView() {
  const state = { ...createInitialState(), activeView: "help" as const };
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

describe("HelpView", () => {
  test("renders Keyboard Shortcuts heading", async () => {
    const { captureCharFrame, renderer } = await renderHelpView();
    const frame = captureCharFrame();
    expect(frame).toContain("Keyboard Shortcuts");
    renderer.destroy();
  });

  test("renders Ctrl+P keybinding hint", async () => {
    const { captureCharFrame, renderer } = await renderHelpView();
    const frame = captureCharFrame();
    expect(frame).toContain("Ctrl+P");
    renderer.destroy();
  });

  test("renders at least one command from COMMAND_DEFINITIONS", async () => {
    const { captureCharFrame, renderer } = await renderHelpView();
    const frame = captureCharFrame();
    // Check that some command labels appear — use the first command as a sample
    const firstLabel = COMMAND_DEFINITIONS[0]?.label;
    if (firstLabel !== undefined) {
      expect(frame).toContain(firstLabel);
    }
    renderer.destroy();
  });

  test("renders command palette heading", async () => {
    const { captureCharFrame, renderer } = await renderHelpView();
    const frame = captureCharFrame();
    expect(frame).toContain("Command Palette");
    renderer.destroy();
  });
});
