/**
 * Chat store tests — ported from TUI store tests, adapted for Zustand.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  type ChatMessage,
  type ChatSession,
  MAX_SESSION_MESSAGES,
  useChatStore,
} from "./chat-store.js";

/** Reset store between tests. */
afterEach(() => {
  useChatStore.setState({
    messages: [],
    session: null,
    isStreaming: false,
    pendingText: "",
    activeToolCalls: {},
    error: null,
    lastUserMessage: null,
    agentTerminated: false,
  });
});

function userMsg(text: string): ChatMessage {
  return { kind: "user", text, timestamp: Date.now() };
}

function assistantMsg(text: string): ChatMessage {
  return { kind: "assistant", text, timestamp: Date.now() };
}

describe("addMessage", () => {
  test("adds a user message", () => {
    useChatStore.getState().addMessage(userMsg("hello"));
    expect(useChatStore.getState().messages).toHaveLength(1);
    expect(useChatStore.getState().messages[0]?.kind).toBe("user");
  });

  test("adds multiple messages in order", () => {
    const { addMessage } = useChatStore.getState();
    addMessage(userMsg("first"));
    addMessage(assistantMsg("second"));
    addMessage(userMsg("third"));
    const msgs = useChatStore.getState().messages;
    expect(msgs).toHaveLength(3);
    expect(msgs[0]?.kind).toBe("user");
    expect(msgs[1]?.kind).toBe("assistant");
    expect(msgs[2]?.kind).toBe("user");
  });

  test("adds tool_call message", () => {
    useChatStore.getState().addMessage({
      kind: "tool_call",
      name: "search",
      args: '{"q":"test"}',
      result: '["result"]',
      timestamp: Date.now(),
    });
    const msg = useChatStore.getState().messages[0];
    expect(msg?.kind).toBe("tool_call");
    if (msg?.kind === "tool_call") {
      expect(msg.name).toBe("search");
    }
  });

  test("adds lifecycle message", () => {
    useChatStore.getState().addMessage({
      kind: "lifecycle",
      event: "agent_started",
      timestamp: Date.now(),
    });
    const msg = useChatStore.getState().messages[0];
    expect(msg?.kind).toBe("lifecycle");
  });
});

describe("sliding window", () => {
  test("trims messages beyond MAX_SESSION_MESSAGES", () => {
    const { addMessage } = useChatStore.getState();
    for (let i = 0; i < MAX_SESSION_MESSAGES + 10; i++) {
      addMessage(userMsg(`msg-${String(i)}`));
    }
    expect(useChatStore.getState().messages).toHaveLength(MAX_SESSION_MESSAGES);
  });

  test("keeps most recent messages after trim", () => {
    const { addMessage } = useChatStore.getState();
    for (let i = 0; i < MAX_SESSION_MESSAGES + 5; i++) {
      addMessage(userMsg(`msg-${String(i)}`));
    }
    const msgs = useChatStore.getState().messages;
    const lastMsg = msgs[msgs.length - 1];
    if (lastMsg?.kind === "user") {
      expect(lastMsg.text).toBe(`msg-${String(MAX_SESSION_MESSAGES + 4)}`);
    }
    const firstMsg = msgs[0];
    if (firstMsg?.kind === "user") {
      expect(firstMsg.text).toBe("msg-5");
    }
  });
});

describe("appendTokens / flushTokens", () => {
  test("appends tokens to pending text", () => {
    const { appendTokens } = useChatStore.getState();
    appendTokens("Hello");
    appendTokens(" world");
    expect(useChatStore.getState().pendingText).toBe("Hello world");
  });

  test("flush creates assistant message from pending text", () => {
    const { appendTokens, flushTokens } = useChatStore.getState();
    appendTokens("Hello world");
    flushTokens();
    expect(useChatStore.getState().pendingText).toBe("");
    expect(useChatStore.getState().messages).toHaveLength(1);
    const msg = useChatStore.getState().messages[0];
    if (msg?.kind === "assistant") {
      expect(msg.text).toBe("Hello world");
    }
  });

  test("flush is no-op when pending text is empty", () => {
    useChatStore.getState().flushTokens();
    expect(useChatStore.getState().messages).toHaveLength(0);
    expect(useChatStore.getState().pendingText).toBe("");
  });

  test("flush merges into existing assistant message when streaming", () => {
    const state = useChatStore.getState();
    state.setStreaming(true);
    state.addMessage(assistantMsg("Hello"));
    state.appendTokens(" world");
    state.flushTokens();

    const msgs = useChatStore.getState().messages;
    expect(msgs).toHaveLength(1);
    if (msgs[0]?.kind === "assistant") {
      expect(msgs[0].text).toBe("Hello world");
    }
  });

  test("flush creates new message when not streaming", () => {
    const state = useChatStore.getState();
    state.setStreaming(false);
    state.addMessage(assistantMsg("Previous"));
    state.appendTokens("New");
    state.flushTokens();

    const msgs = useChatStore.getState().messages;
    expect(msgs).toHaveLength(2);
  });
});

describe("streaming state", () => {
  test("setStreaming updates isStreaming", () => {
    useChatStore.getState().setStreaming(true);
    expect(useChatStore.getState().isStreaming).toBe(true);
    useChatStore.getState().setStreaming(false);
    expect(useChatStore.getState().isStreaming).toBe(false);
  });
});

describe("session management", () => {
  test("setSession clears all state", () => {
    const state = useChatStore.getState();
    state.addMessage(userMsg("hello"));
    state.setStreaming(true);
    state.setError("something");
    state.appendTokens("pending");

    const session: ChatSession = {
      agentId: "agent-1",
      sessionId: "sess-1",
      threadId: "thread-1",
    };
    state.setSession(session);

    const newState = useChatStore.getState();
    expect(newState.session).toEqual(session);
    expect(newState.messages).toHaveLength(0);
    expect(newState.isStreaming).toBe(false);
    expect(newState.pendingText).toBe("");
    expect(newState.error).toBeNull();
    expect(newState.activeToolCalls).toEqual({});
  });

  test("setSession to null clears session", () => {
    useChatStore.getState().setSession({
      agentId: "a1",
      sessionId: "s1",
      threadId: "t1",
    });
    useChatStore.getState().setSession(null);
    expect(useChatStore.getState().session).toBeNull();
  });
});

describe("tool call tracking", () => {
  test("startToolCall registers a tool call", () => {
    useChatStore.getState().startToolCall("tc1", "search");
    const tc = useChatStore.getState().activeToolCalls;
    expect(tc.tc1?.name).toBe("search");
    expect(tc.tc1?.args).toBe("");
  });

  test("appendToolCallArgs accumulates args", () => {
    const state = useChatStore.getState();
    state.startToolCall("tc1", "search");
    state.appendToolCallArgs("tc1", '{"q":');
    state.appendToolCallArgs("tc1", '"test"}');
    expect(useChatStore.getState().activeToolCalls.tc1?.args).toBe('{"q":"test"}');
  });

  test("appendToolCallArgs is no-op for unknown toolCallId", () => {
    useChatStore.getState().appendToolCallArgs("unknown", "data");
    expect(useChatStore.getState().activeToolCalls).toEqual({});
  });

  test("finishToolCall creates message and removes from active", () => {
    const state = useChatStore.getState();
    state.startToolCall("tc1", "search");
    state.appendToolCallArgs("tc1", '{"q":"test"}');
    state.finishToolCall("tc1", '["result1"]');

    expect(useChatStore.getState().activeToolCalls.tc1).toBeUndefined();
    const msgs = useChatStore.getState().messages;
    expect(msgs).toHaveLength(1);
    const msg = msgs[0];
    if (msg?.kind === "tool_call") {
      expect(msg.name).toBe("search");
      expect(msg.args).toBe('{"q":"test"}');
      expect(msg.result).toBe('["result1"]');
    }
  });

  test("finishToolCall with undefined result", () => {
    const state = useChatStore.getState();
    state.startToolCall("tc1", "lookup");
    state.finishToolCall("tc1", undefined);

    const msg = useChatStore.getState().messages[0];
    if (msg?.kind === "tool_call") {
      expect(msg.result).toBeUndefined();
    }
  });

  test("finishToolCall is no-op for unknown toolCallId", () => {
    useChatStore.getState().finishToolCall("unknown", "result");
    expect(useChatStore.getState().messages).toHaveLength(0);
  });
});

describe("error state", () => {
  test("setError stores error message", () => {
    useChatStore.getState().setError("Connection lost");
    expect(useChatStore.getState().error).toBe("Connection lost");
  });

  test("setError to null clears error", () => {
    useChatStore.getState().setError("fail");
    useChatStore.getState().setError(null);
    expect(useChatStore.getState().error).toBeNull();
  });
});

describe("clearMessages", () => {
  test("clears messages, pending text, and tool calls", () => {
    const state = useChatStore.getState();
    state.addMessage(userMsg("hello"));
    state.appendTokens("pending");
    state.startToolCall("tc1", "search");

    state.clearMessages();

    const cleared = useChatStore.getState();
    expect(cleared.messages).toHaveLength(0);
    expect(cleared.pendingText).toBe("");
    expect(cleared.activeToolCalls).toEqual({});
  });
});
