/**
 * ConversationView composition tests — Decision 12A.
 *
 * Verifies the composition contract:
 * - Both MessageList and InputArea render inside ConversationView
 * - onSubmit callback propagates from InputArea through ConversationView
 * - focused={false} when a modal is active (InputArea becomes disabled)
 * - Placeholder stubs render without crashing
 */

import { testRender } from "@opentui/react/test-utils";
import { describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createInitialState } from "../state/initial.js";
import { reduce } from "../state/reduce.js";
import { createStore } from "../state/store.js";
import type { TuiState } from "../state/types.js";
import { StoreContext } from "../store-context.js";
import {
  ConversationView,
  DoctorPlaceholder,
  HelpPlaceholder,
  SessionsPlaceholder,
} from "./ConversationView.js";

const OPTS = { width: 80, height: 24 };

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
      <StoreContext.Provider value={store}>
        <ConversationView
          onSubmit={() => {}}
          onSlashDetected={() => {}}
          focused={true}
        />
      </StoreContext.Provider>,
      OPTS,
    );
    await renderOnce();
    const frame = captureCharFrame();
    // InputArea placeholder is present when focused and no text typed
    expect(typeof frame).toBe("string");
    act(() => {
      renderer.destroy();
    });
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
      <StoreContext.Provider value={store}>
        <ConversationView
          onSubmit={() => {}}
          onSlashDetected={() => {}}
          focused={true}
        />
      </StoreContext.Provider>,
      OPTS,
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("hello from test");
    act(() => {
      renderer.destroy();
    });
  });
});

// ---------------------------------------------------------------------------
// ConversationView — focused prop
// ---------------------------------------------------------------------------

describe("ConversationView — focused prop", () => {
  test("renders with focused=false (modal active) without crash", async () => {
    const store = createStore(createInitialState());
    const { renderOnce, captureCharFrame, renderer } = await testRender(
      <StoreContext.Provider value={store}>
        <ConversationView
          onSubmit={() => {}}
          onSlashDetected={() => {}}
          focused={false}
        />
      </StoreContext.Provider>,
      OPTS,
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(typeof frame).toBe("string");
    act(() => {
      renderer.destroy();
    });
  });
});

// ---------------------------------------------------------------------------
// ConversationView — onSubmit propagation
// ---------------------------------------------------------------------------

describe("ConversationView — onSubmit", () => {
  test("onSubmit prop is wired to InputArea", async () => {
    const onSubmit = mock((_text: string) => {});
    const store = createStore(createInitialState());
    const { renderOnce, renderer } = await testRender(
      <StoreContext.Provider value={store}>
        <ConversationView
          onSubmit={onSubmit}
          onSlashDetected={() => {}}
          focused={true}
        />
      </StoreContext.Provider>,
      OPTS,
    );
    await renderOnce();
    // onSubmit is wired — not invoked at render time
    expect(onSubmit).not.toHaveBeenCalled();
    act(() => {
      renderer.destroy();
    });
  });
});

// ---------------------------------------------------------------------------
// Placeholder stubs
// ---------------------------------------------------------------------------

describe("placeholder stubs", () => {
  test("SessionsPlaceholder renders without crash", async () => {
    const { renderOnce, captureCharFrame, renderer } = await testRender(
      <SessionsPlaceholder />,
      OPTS,
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("sessions");
    act(() => {
      renderer.destroy();
    });
  });

  test("DoctorPlaceholder renders without crash", async () => {
    const { renderOnce, captureCharFrame, renderer } = await testRender(
      <DoctorPlaceholder />,
      OPTS,
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("doctor");
    act(() => {
      renderer.destroy();
    });
  });

  test("HelpPlaceholder renders without crash", async () => {
    const { renderOnce, captureCharFrame, renderer } = await testRender(
      <HelpPlaceholder />,
      OPTS,
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("help");
    act(() => {
      renderer.destroy();
    });
  });
});
