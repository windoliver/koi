/**
 * ConsoleView tests — session init, error banner, back navigation.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, fireEvent } from "@testing-library/react";
import { useChatStore } from "../../stores/chat-store.js";
import { render, screen } from "../../__tests__/setup.js";
import { ConsoleView } from "./console-view.js";

/**
 * Mock the useAguiChat hook — we test the hook separately.
 * The ConsoleView just wires the hook's sendMessage/cancel to the UI.
 */
const mockSendMessage = mock(() => {});
const mockCancel = mock(() => {});

mock.module("../../hooks/use-agui-chat.js", () => ({
  useAguiChat: () => ({
    sendMessage: mockSendMessage,
    cancel: mockCancel,
  }),
}));

/** Mock useAgentById — returns a simple agent object. */
mock.module("../../stores/agents-store.js", () => ({
  useAgentById: (id: string) =>
    id === "agent-1"
      ? {
          agentId: "agent-1",
          name: "test-agent",
          agentType: "copilot",
          state: "running",
          model: "claude-sonnet-4-6",
          channels: ["cli"],
          turns: 5,
          startedAt: Date.now(),
          lastActivityAt: Date.now(),
        }
      : undefined,
}));

afterEach(() => {
  useChatStore.setState({
    messages: [],
    session: null,
    isStreaming: false,
    pendingText: "",
    activeToolCalls: {},
    error: null,
  });
  mockSendMessage.mockClear();
  mockCancel.mockClear();
});

function renderConsole(agentId = "agent-1"): ReturnType<typeof render> {
  const onBack = mock(() => {});
  return render(<ConsoleView agentId={agentId} onBack={onBack} />);
}

describe("ConsoleView", () => {
  test("initializes session on mount", () => {
    renderConsole("agent-1");
    const session = useChatStore.getState().session;
    expect(session).not.toBeNull();
    expect(session?.agentId).toBe("agent-1");
  });

  test("renders agent name via header", () => {
    renderConsole("agent-1");
    expect(screen.getByText("test-agent")).toBeDefined();
  });

  test("renders composer", () => {
    renderConsole();
    expect(screen.getByPlaceholderText("Send a message...")).toBeDefined();
  });

  test("shows empty conversation state initially", () => {
    renderConsole();
    expect(screen.getByText("Send a message to start the conversation")).toBeDefined();
  });

  test("shows error banner when error is set", () => {
    renderConsole();
    // Set error after mount (setSession on mount clears error)
    act(() => { useChatStore.getState().setError("Connection lost"); });
    expect(screen.getByText("Connection lost")).toBeDefined();
  });

  test("error banner has dismiss button", () => {
    renderConsole();
    act(() => { useChatStore.getState().setError("Something failed"); });
    const dismiss = screen.getByText("Dismiss");
    expect(dismiss).toBeDefined();

    fireEvent.click(dismiss);
    expect(useChatStore.getState().error).toBeNull();
  });

  test("does not show error banner when no error", () => {
    renderConsole();
    const dismiss = screen.queryAllByText("Dismiss");
    expect(dismiss.length).toBe(0);
  });

  test("renders Back button", () => {
    renderConsole();
    expect(screen.getByText("Back")).toBeDefined();
  });
});
