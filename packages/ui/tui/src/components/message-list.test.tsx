/**
 * MessageList integration tests — verifies store -> component -> render pipeline.
 *
 * Uses pre-built state (via the reducer) to test rendering, since OpenTUI's
 * test renderer doesn't support useSyncExternalStore re-render cycles.
 * The reducer is already thoroughly tested; these tests verify the component
 * tree correctly renders the materialized state.
 */

import { testRender } from "@opentui/react/test-utils";
import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createInitialState } from "../state/initial.js";
import { reduce } from "../state/reduce.js";
import { createStore } from "../state/store.js";
import type { TuiState } from "../state/types.js";
import { StoreContext } from "../store-context.js";
import { MessageList } from "./message-list.js";

const RENDER_OPTS = { width: 80, height: 24 };

async function renderList(state: TuiState): Promise<string> {
  const store = createStore(state);
  const { captureCharFrame, renderOnce, renderer } = await testRender(
    <StoreContext.Provider value={store}>
      <MessageList />
    </StoreContext.Provider>,
    RENDER_OPTS,
  );
  await renderOnce();
  const frame = captureCharFrame();
  act(() => {
    renderer.destroy();
  });
  return frame;
}

/** Apply a sequence of actions to initial state. */
function buildState(
  actions: ReadonlyArray<Parameters<typeof reduce>[1]>,
): TuiState {
  let state = createInitialState();
  for (const action of actions) {
    state = reduce(state, action);
  }
  return state;
}

describe("MessageList — rendering", () => {
  test("renders empty conversation without message content", async () => {
    const frame = await renderList(createInitialState());
    // No message text — only potential scrollbar chrome
    expect(frame).not.toContain("You:");
    expect(frame).not.toContain("Error");
  });

  test("renders user message", async () => {
    const state = buildState([
      {
        kind: "add_user_message",
        id: "user-1",
        blocks: [{ kind: "text", text: "What is Koi?" }],
      },
    ]);
    const frame = await renderList(state);
    expect(frame).toContain("What is Koi?");
  });

  test("renders assistant message from streaming deltas", async () => {
    const state = buildState([
      { kind: "engine_event", event: { kind: "turn_start", turnIndex: 0 } },
      { kind: "engine_event", event: { kind: "text_delta", delta: "Koi is " } },
      { kind: "engine_event", event: { kind: "text_delta", delta: "an agent engine." } },
      { kind: "engine_event", event: { kind: "turn_end", turnIndex: 0 } },
    ]);
    const frame = await renderList(state);
    expect(frame).toContain("Koi is an agent engine.");
  });

  test("renders multi-turn conversation", async () => {
    const state = buildState([
      {
        kind: "add_user_message",
        id: "user-1",
        blocks: [{ kind: "text", text: "Hello" }],
      },
      { kind: "engine_event", event: { kind: "turn_start", turnIndex: 0 } },
      { kind: "engine_event", event: { kind: "text_delta", delta: "Hi there!" } },
      { kind: "engine_event", event: { kind: "turn_end", turnIndex: 0 } },
    ]);
    const frame = await renderList(state);
    expect(frame).toContain("Hello");
    expect(frame).toContain("Hi there!");
  });

  test("renders tool call with result", async () => {
    const state = buildState([
      { kind: "engine_event", event: { kind: "turn_start", turnIndex: 0 } },
      {
        kind: "engine_event",
        event: {
          kind: "tool_call_start",
          toolName: "read_file",
          callId: "call-1" as never,
        },
      },
      {
        kind: "engine_event",
        event: {
          kind: "tool_call_end",
          callId: "call-1" as never,
          result: "file contents here",
        },
      },
      { kind: "engine_event", event: { kind: "turn_end", turnIndex: 0 } },
    ]);
    const frame = await renderList(state);
    expect(frame).toContain("read_file");
    expect(frame).toContain("file contents here");
  });

  test("renders error block", async () => {
    const state = buildState([
      { kind: "add_error", code: "TIMEOUT", message: "Request timed out" },
    ]);
    const frame = await renderList(state);
    expect(frame).toContain("TIMEOUT");
    expect(frame).toContain("Request timed out");
  });
});
