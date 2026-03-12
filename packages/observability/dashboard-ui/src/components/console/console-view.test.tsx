/**
 * ConsoleView tests — session init, error banner with retry, back navigation.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { fireEvent } from "@testing-library/react";
import { useChatStore } from "../../stores/chat-store.js";
import { render } from "../../__tests__/setup.js";
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
    rerenderConsole: () => {
      result.rerender(<ConsoleView agentId={agentId} onBack={onBack} />);
    },
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
    const { getAllByText } = renderConsole("agent-1");
    const matches = getAllByText("test-agent");
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  test("renders composer", () => {
    const { getByPlaceholderText } = renderConsole();
    expect(getByPlaceholderText("Send a message...")).toBeDefined();
  });

  test("shows empty conversation state initially", () => {
    const { getByText } = renderConsole();
    expect(getByText("Send a message to start the conversation")).toBeDefined();
  });

  test("shows error banner when error is set", () => {
    const { rerenderConsole, getByText } = renderConsole();
    useChatStore.setState({ error: "Connection lost" });
    rerenderConsole();
    expect(getByText("Connection lost")).toBeDefined();
  });

  test("error banner has dismiss button", () => {
    const { rerenderConsole, getByText } = renderConsole();
    useChatStore.setState({ error: "Something failed" });
    rerenderConsole();
    const dismiss = getByText("Dismiss");
    expect(dismiss).toBeDefined();

    fireEvent.click(dismiss);
    expect(useChatStore.getState().error).toBeNull();
  });

  test("shows retry button when error and lastUserMessage exist", () => {
    const { rerenderConsole, getByText } = renderConsole();
    useChatStore.setState({ error: "Stream failed", lastUserMessage: "hello" });
    rerenderConsole();
    expect(getByText("Retry")).toBeDefined();
  });

  test("does not show retry button when no lastUserMessage", () => {
    const { rerenderConsole, queryAllByText } = renderConsole();
    useChatStore.setState({ error: "Stream failed" });
    rerenderConsole();
    const retry = queryAllByText("Retry");
    expect(retry.length).toBe(0);
  });

  test("does not show error banner when no error", () => {
    const { queryAllByText } = renderConsole();
    const dismiss = queryAllByText("Dismiss");
    expect(dismiss.length).toBe(0);
  });

  test("renders Back button", () => {
    const { getByText } = renderConsole();
    expect(getByText("Back")).toBeDefined();
  });

  test("shows terminated banner when agent is terminated", () => {
    const { rerenderConsole, getByText } = renderConsole();
    useChatStore.setState({ agentTerminated: true });
    rerenderConsole();
    expect(getByText(/Agent has been terminated/)).toBeDefined();
  });

  test("shows session picker with 'No previous sessions'", () => {
    const { getByText } = renderConsole();
    expect(getByText("No previous sessions")).toBeDefined();
  });
});
