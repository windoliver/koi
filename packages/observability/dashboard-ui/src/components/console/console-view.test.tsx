/**
 * ConsoleView tests — session init, error banner with retry, back navigation.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { fireEvent } from "@testing-library/react";
import { useChatStore } from "../../stores/chat-store.js";
import { render, screen } from "../../__tests__/setup.js";
import { ConsoleView } from "./console-view.js";

/**
 * Mock the useAguiChat hook — we test the hook separately.
 */
const mockSendMessage = mock(() => {});
const mockCancel = mock(() => {});
const mockRetry = mock(() => {});

mock.module("../../hooks/use-agui-chat.js", () => ({
  useAguiChat: () => ({
    sendMessage: mockSendMessage,
    cancel: mockCancel,
    retry: mockRetry,
  }),
}));

/** Mock useAgentById. */
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

/** Mock useSessionHistory — return empty sessions with stable references. */
const mockLoadSession = mock(async () => {});
const mockRefresh = mock(() => {});
const mockPersistCurrentSession = mock(async () => {});
const sessionHistoryResult = {
  sessions: [],
  isLoading: false,
  loadSession: mockLoadSession,
  refresh: mockRefresh,
  persistCurrentSession: mockPersistCurrentSession,
};
mock.module("../../hooks/use-session-history.js", () => ({
  useSessionHistory: () => sessionHistoryResult,
}));

/** Mock connection store. */
mock.module("../../stores/connection-store.js", () => ({
  useConnectionStore: (selector: (s: { readonly status: string }) => unknown) =>
    selector({ status: "connected" }),
}));

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
  mockSendMessage.mockClear();
  mockCancel.mockClear();
  mockRetry.mockClear();
});

function renderConsole(agentId = "agent-1"): ReturnType<typeof render> & { readonly rerenderConsole: () => void } {
  const onBack = mock(() => {});
  const result = render(<ConsoleView agentId={agentId} onBack={onBack} />);
  return {
    ...result,
    rerenderConsole: () => result.rerender(<ConsoleView agentId={agentId} onBack={onBack} />),
  };
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
    const { rerenderConsole } = renderConsole();
    useChatStore.setState({ error: "Connection lost" });
    rerenderConsole();
    expect(screen.getByText("Connection lost")).toBeDefined();
  });

  test("error banner has dismiss button", () => {
    const { rerenderConsole } = renderConsole();
    useChatStore.setState({ error: "Something failed" });
    rerenderConsole();
    const dismiss = screen.getByText("Dismiss");
    expect(dismiss).toBeDefined();

    fireEvent.click(dismiss);
    expect(useChatStore.getState().error).toBeNull();
  });

  test("shows retry button when error and lastUserMessage exist", () => {
    const { rerenderConsole } = renderConsole();
    useChatStore.setState({ error: "Stream failed", lastUserMessage: "hello" });
    rerenderConsole();
    expect(screen.getByText("Retry")).toBeDefined();
  });

  test("does not show retry button when no lastUserMessage", () => {
    const { rerenderConsole } = renderConsole();
    useChatStore.setState({ error: "Stream failed" });
    rerenderConsole();
    const retry = screen.queryAllByText("Retry");
    expect(retry.length).toBe(0);
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

  test("shows terminated banner when agent is terminated", () => {
    const { rerenderConsole } = renderConsole();
    useChatStore.setState({ agentTerminated: true });
    rerenderConsole();
    expect(screen.getByText(/Agent has been terminated/)).toBeDefined();
  });

  test("shows session picker with 'No previous sessions'", () => {
    renderConsole();
    expect(screen.getByText("No previous sessions")).toBeDefined();
  });
});
