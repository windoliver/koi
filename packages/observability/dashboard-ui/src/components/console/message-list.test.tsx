/**
 * MessageList tests — empty state, message rendering, streaming indicators.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { ChatMessage } from "../../stores/chat-store.js";
import { MAX_RENDERED_MESSAGES, useChatStore } from "../../stores/chat-store.js";
import { render, screen } from "../../__tests__/setup.js";
import { MessageList } from "./message-list.js";

/** Reset chat store between tests. */
afterEach(() => {
  useChatStore.setState({
    messages: [],
    session: null,
    isStreaming: false,
    pendingText: "",
    activeToolCalls: {},
    error: null,
  });
});

function userMsg(text: string): ChatMessage {
  return { kind: "user", text, timestamp: Date.now() };
}

function assistantMsg(text: string): ChatMessage {
  return { kind: "assistant", text, timestamp: Date.now() };
}

describe("MessageList", () => {
  test("shows empty state when no messages and not streaming", () => {
    render(<MessageList />);
    expect(screen.getByText("Send a message to start the conversation")).toBeDefined();
  });

  test("does not show empty state when messages exist", () => {
    useChatStore.getState().addMessage(userMsg("hello"));
    render(<MessageList />);
    const emptyStates = screen.queryAllByText("Send a message to start the conversation");
    expect(emptyStates.length).toBe(0);
  });

  test("renders user and assistant messages", () => {
    const state = useChatStore.getState();
    state.addMessage(userMsg("What is 2+2?"));
    state.addMessage(assistantMsg("4"));

    render(<MessageList />);
    expect(screen.getByText("What is 2+2?")).toBeDefined();
    expect(screen.getByText("4")).toBeDefined();
  });

  test("shows 'Thinking...' when streaming with no pending text and messages exist", () => {
    const state = useChatStore.getState();
    state.addMessage(userMsg("hello"));
    state.setStreaming(true);

    render(<MessageList />);
    expect(screen.getByText("Thinking...")).toBeDefined();
  });

  test("does not show 'Thinking...' when not streaming", () => {
    useChatStore.getState().addMessage(userMsg("hello"));
    render(<MessageList />);
    const thinking = screen.queryAllByText("Thinking...");
    expect(thinking.length).toBe(0);
  });

  test("does not show 'Thinking...' when streaming with pending text", () => {
    const state = useChatStore.getState();
    state.addMessage(userMsg("hello"));
    state.setStreaming(true);
    state.appendTokens("Some partial text");

    render(<MessageList />);
    const thinking = screen.queryAllByText("Thinking...");
    expect(thinking.length).toBe(0);
  });

  test("shows streaming indicator when streaming with pending text", () => {
    const state = useChatStore.getState();
    state.addMessage(userMsg("hello"));
    state.setStreaming(true);
    state.appendTokens("Partial response");

    render(<MessageList />);
    expect(screen.getByText("Partial response")).toBeDefined();
  });

  test("shows 'earlier messages' indicator when total exceeds MAX_RENDERED_MESSAGES", () => {
    const state = useChatStore.getState();
    const count = MAX_RENDERED_MESSAGES + 20;
    for (let i = 0; i < count; i++) {
      state.addMessage(userMsg(`msg-${String(i)}`));
    }

    render(<MessageList />);
    expect(screen.getByText("20 earlier messages not shown")).toBeDefined();
  });

  test("does not show 'earlier messages' when under threshold", () => {
    const state = useChatStore.getState();
    for (let i = 0; i < 5; i++) {
      state.addMessage(userMsg(`msg-${String(i)}`));
    }

    render(<MessageList />);
    const earlier = screen.queryAllByText(/earlier messages not shown/);
    expect(earlier.length).toBe(0);
  });
});
