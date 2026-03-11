/**
 * Tests for TUI app wiring logic.
 *
 * Since tui-app.ts requires a ProcessTerminal (raw TTY),
 * we test the store-level integration patterns that the app wires.
 */

import { describe, expect, test } from "bun:test";
import { createStore, reduce } from "../state/store.js";
import {
  type ChatMessage,
  createInitialState,
  type SessionState,
  type TuiAction,
  type TuiState,
} from "../state/types.js";

/** Helper: create a state with an active session. */
function stateWithSession(overrides: Partial<SessionState> = {}): TuiState {
  return {
    ...createInitialState("http://localhost:3100/admin/api"),
    view: "console",
    activeSession: {
      agentId: "a1",
      sessionId: "s1",
      messages: [],
      pendingText: "",
      isStreaming: false,
      ...overrides,
    },
  };
}

describe("AG-UI event → store integration", () => {
  test("append_tokens accumulates streaming text", () => {
    let state = stateWithSession();
    state = reduce(state, { kind: "append_tokens", text: "Hello" });
    state = reduce(state, { kind: "append_tokens", text: " world" });
    expect(state.activeSession?.pendingText).toBe("Hello world");
  });

  test("flush_tokens moves pending text to messages", () => {
    let state = stateWithSession({ pendingText: "Complete response" });
    state = reduce(state, { kind: "flush_tokens" });
    expect(state.activeSession?.pendingText).toBe("");
    expect(state.activeSession?.messages).toHaveLength(1);
    const msg = state.activeSession?.messages[0];
    expect(msg?.kind).toBe("assistant");
    if (msg?.kind === "assistant") {
      expect(msg.text).toBe("Complete response");
    }
  });

  test("add_message adds lifecycle events", () => {
    let state = stateWithSession();
    const msg: ChatMessage = {
      kind: "lifecycle",
      event: "Run started",
      timestamp: Date.now(),
    };
    state = reduce(state, { kind: "add_message", message: msg });
    expect(state.activeSession?.messages).toHaveLength(1);
    expect(state.activeSession?.messages[0]?.kind).toBe("lifecycle");
  });

  test("add_message adds tool call events", () => {
    let state = stateWithSession();
    const msg: ChatMessage = {
      kind: "tool_call",
      name: "search_web",
      args: '{"q":"test"}',
      result: undefined,
      timestamp: Date.now(),
    };
    state = reduce(state, { kind: "add_message", message: msg });
    expect(state.activeSession?.messages).toHaveLength(1);
    if (state.activeSession?.messages[0]?.kind === "tool_call") {
      expect(state.activeSession.messages[0].name).toBe("search_web");
    }
  });

  test("full streaming sequence: tokens → flush → lifecycle", () => {
    let state = stateWithSession();

    // User sends message
    state = reduce(state, {
      kind: "add_message",
      message: { kind: "user", text: "hello", timestamp: 1 },
    });

    // Lifecycle: run started
    state = reduce(state, {
      kind: "add_message",
      message: { kind: "lifecycle", event: "Run started", timestamp: 2 },
    });

    // Stream tokens
    state = reduce(state, { kind: "append_tokens", text: "I'm " });
    state = reduce(state, { kind: "append_tokens", text: "an AI" });
    expect(state.activeSession?.pendingText).toBe("I'm an AI");

    // Flush on TEXT_MESSAGE_END
    state = reduce(state, { kind: "flush_tokens" });
    expect(state.activeSession?.pendingText).toBe("");

    // Lifecycle: run finished
    state = reduce(state, {
      kind: "add_message",
      message: { kind: "lifecycle", event: "Run finished", timestamp: 3 },
    });

    // Verify message sequence
    const messages = state.activeSession?.messages ?? [];
    expect(messages).toHaveLength(4);
    expect(messages[0]?.kind).toBe("user");
    expect(messages[1]?.kind).toBe("lifecycle");
    expect(messages[2]?.kind).toBe("assistant");
    expect(messages[3]?.kind).toBe("lifecycle");
  });

  test("set_session null clears session", () => {
    let state = stateWithSession({ messages: [{ kind: "user", text: "hi", timestamp: 1 }] });
    state = reduce(state, { kind: "set_session", session: null });
    expect(state.activeSession).toBeNull();
  });

  test("set_streaming toggles isStreaming flag", () => {
    let state = stateWithSession();
    expect(state.activeSession?.isStreaming).toBe(false);

    state = reduce(state, { kind: "set_streaming", isStreaming: true });
    expect(state.activeSession?.isStreaming).toBe(true);

    state = reduce(state, { kind: "set_streaming", isStreaming: false });
    expect(state.activeSession?.isStreaming).toBe(false);
  });

  test("set_streaming is no-op without active session", () => {
    let state = createInitialState("http://localhost:3100/admin/api");
    const prev = state;
    state = reduce(state, { kind: "set_streaming", isStreaming: true });
    expect(state).toBe(prev); // same reference — no change
  });

  test("set_session with loaded messages preserves history", () => {
    let state = stateWithSession();
    const loadedMessages: readonly ChatMessage[] = [
      { kind: "user", text: "old message", timestamp: 100 },
      { kind: "assistant", text: "old reply", timestamp: 200 },
      { kind: "lifecycle", event: "Run finished", timestamp: 300 },
    ];
    state = reduce(state, {
      kind: "set_session",
      session: {
        agentId: "a2",
        sessionId: "loaded-session",
        messages: loadedMessages,
        pendingText: "",
        isStreaming: false,
      },
    });
    expect(state.activeSession?.sessionId).toBe("loaded-session");
    expect(state.activeSession?.messages).toHaveLength(3);
    expect(state.activeSession?.messages[0]?.kind).toBe("user");
    expect(state.activeSession?.messages[2]?.kind).toBe("lifecycle");
  });
});

describe("store subscribe pattern", () => {
  test("subscribers receive updates for AG-UI actions", () => {
    const store = createStore(stateWithSession());
    const actions: TuiAction[] = [];

    store.subscribe(() => {
      actions.push({ kind: "set_view", view: "console" }); // marker
    });

    store.dispatch({ kind: "append_tokens", text: "hello" });
    store.dispatch({ kind: "flush_tokens" });

    // Subscribe was called twice (once per dispatch)
    expect(actions).toHaveLength(2);
  });
});
