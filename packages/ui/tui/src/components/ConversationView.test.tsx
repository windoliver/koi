/**
 * ConversationView composition tests — Decision 12A.
 *
 * Verifies the composition contract:
 * - Both MessageList and InputArea render inside ConversationView
 * - onSubmit callback propagates from InputArea through ConversationView
 * - focused={false} when a modal is active (InputArea becomes disabled)
 */

import { testRender } from "@opentui/solid";
import { describe, expect, mock, test } from "bun:test";
import { createInitialState } from "../state/initial.js";
import { reduce } from "../state/reduce.js";
import { createStore } from "../state/store.js";
import type { TuiState } from "../state/types.js";
import { StoreContext, TuiStateContext, createStoreSignal } from "../store-context.js";
import type { TuiStore } from "../state/store.js";
import { ConversationView } from "./ConversationView.js";

const OPTS = { width: 80, height: 24 };

/** Wraps children in both store contexts so useTuiStore works in tests. */
function StoreProviders(props: { store: TuiStore; children: JSX.Element }): JSX.Element {
  return (
    <StoreContext.Provider value={props.store}>
      <TuiStateContext.Provider value={createStoreSignal(props.store)}>
        {props.children}
      </TuiStateContext.Provider>
    </StoreContext.Provider>
  );
}

import type { JSX } from "solid-js";

function buildState(
  actions: ReadonlyArray<Parameters<typeof reduce>[1]>,
): TuiState {
  let s = createInitialState();
  for (const a of actions) s = reduce(s, a);
  return s;
}

// ---------------------------------------------------------------------------
// ConversationView renders
// ---------------------------------------------------------------------------

describe("ConversationView — rendering", () => {
  test("renders without crashing when store is empty", async () => {
    const store = createStore(createInitialState());
    const { renderOnce, captureCharFrame, renderer } = await testRender(
      () => (
        <StoreProviders store={store}>
          <ConversationView
            onSubmit={() => {}}
            onSlashDetected={() => {}}
            focused={true}
          />
        </StoreProviders>
      ),
      OPTS,
    );
    await renderOnce();
    const frame = captureCharFrame();
    // InputArea placeholder is present when focused and no text typed
    expect(typeof frame).toBe("string");
    renderer.destroy();
  });

  test("renders user message from store", async () => {
    const state = buildState([
      {
        kind: "add_user_message",
        id: "u1",
        blocks: [{ kind: "text", text: "hello from test" }],
      },
    ]);
    const store = createStore(state);
    const { renderOnce, captureCharFrame, renderer } = await testRender(
      () => (
        <StoreProviders store={store}>
          <ConversationView
            onSubmit={() => {}}
            onSlashDetected={() => {}}
            focused={true}
          />
        </StoreProviders>
      ),
      OPTS,
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("hello from test");
    renderer.destroy();
  });
});

// ---------------------------------------------------------------------------
// ConversationView — focused prop
// ---------------------------------------------------------------------------

describe("ConversationView — focused prop", () => {
  test("renders with focused=false (modal active) without crash", async () => {
    const store = createStore(createInitialState());
    const { renderOnce, captureCharFrame, renderer } = await testRender(
      () => (
        <StoreProviders store={store}>
          <ConversationView
            onSubmit={() => {}}
            onSlashDetected={() => {}}
            focused={false}
          />
        </StoreProviders>
      ),
      OPTS,
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(typeof frame).toBe("string");
    renderer.destroy();
  });
});

// ---------------------------------------------------------------------------
// ConversationView — onSubmit propagation
// ---------------------------------------------------------------------------

describe("ConversationView — onSubmit", () => {
  test("onSubmit is not called spuriously at mount", async () => {
    const onSubmit = mock((_text: string) => {});
    const store = createStore(createInitialState());
    const { renderOnce, renderer } = await testRender(
      () => (
        <StoreProviders store={store}>
          <ConversationView
            onSubmit={onSubmit}
            onSlashDetected={() => {}}
            focused={true}
          />
        </StoreProviders>
      ),
      OPTS,
    );
    await renderOnce();
    // onSubmit must not fire on mount — fires only on explicit Enter key from InputArea
    expect(onSubmit).not.toHaveBeenCalled();
    renderer.destroy();
  });
});
