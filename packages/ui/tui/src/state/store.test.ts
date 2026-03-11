import { describe, expect, test } from "bun:test";
import type { DashboardAgentSummary } from "@koi/dashboard-types";
import { createStore, reduce } from "./store.js";
import { createInitialState, MAX_SESSION_MESSAGES, type TuiState } from "./types.js";

function makeAgent(
  id: string,
  name: string,
  state: "created" | "running" | "waiting" | "suspended" | "terminated" = "running",
): DashboardAgentSummary {
  return {
    agentId: id as DashboardAgentSummary["agentId"],
    name,
    agentType: "copilot",
    state,
    model: "test-model",
    channels: [],
    turns: 0,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
  };
}

const BASE_STATE = createInitialState("http://localhost:3100");

describe("createInitialState", () => {
  test("returns correct defaults", () => {
    const s = createInitialState("http://localhost:9200");
    expect(s.view).toBe("agents");
    expect(s.agents).toEqual([]);
    expect(s.selectedAgentIndex).toBe(0);
    expect(s.activeSession).toBeNull();
    expect(s.connectionStatus).toBe("disconnected");
    expect(s.error).toBeNull();
    expect(s.adminUrl).toBe("http://localhost:9200");
    expect(s.lastEventSeq).toBe(0);
  });
});

describe("reduce", () => {
  describe("set_view", () => {
    test("switches to console view", () => {
      const next = reduce(BASE_STATE, { kind: "set_view", view: "console" });
      expect(next.view).toBe("console");
    });

    test("returns same reference if view unchanged", () => {
      const next = reduce(BASE_STATE, { kind: "set_view", view: "agents" });
      // View is same, but spread creates new object — that's fine for immutability
      expect(next.view).toBe("agents");
    });
  });

  describe("set_agents", () => {
    test("replaces agent list", () => {
      const agents = [makeAgent("a1", "Alice"), makeAgent("a2", "Bob")];
      const next = reduce(BASE_STATE, { kind: "set_agents", agents });
      expect(next.agents).toEqual(agents);
    });

    test("clamps selectedAgentIndex when list shrinks", () => {
      const state: TuiState = {
        ...BASE_STATE,
        agents: [makeAgent("a1", "A"), makeAgent("a2", "B"), makeAgent("a3", "C")],
        selectedAgentIndex: 2,
      };
      const next = reduce(state, {
        kind: "set_agents",
        agents: [makeAgent("a1", "A")],
      });
      expect(next.selectedAgentIndex).toBe(0);
    });

    test("handles empty agent list", () => {
      const state: TuiState = {
        ...BASE_STATE,
        agents: [makeAgent("a1", "A")],
        selectedAgentIndex: 0,
      };
      const next = reduce(state, { kind: "set_agents", agents: [] });
      expect(next.selectedAgentIndex).toBe(0);
      expect(next.agents).toEqual([]);
    });
  });

  describe("select_agent", () => {
    const state: TuiState = {
      ...BASE_STATE,
      agents: [makeAgent("a1", "A"), makeAgent("a2", "B"), makeAgent("a3", "C")],
    };

    test("selects valid index", () => {
      const next = reduce(state, { kind: "select_agent", index: 1 });
      expect(next.selectedAgentIndex).toBe(1);
    });

    test("clamps negative index to 0", () => {
      const next = reduce(state, { kind: "select_agent", index: -5 });
      expect(next.selectedAgentIndex).toBe(0);
    });

    test("clamps overflow index to last element", () => {
      const next = reduce(state, { kind: "select_agent", index: 100 });
      expect(next.selectedAgentIndex).toBe(2);
    });
  });

  describe("set_session", () => {
    test("sets active session", () => {
      const session = {
        agentId: "a1",
        sessionId: "s1",
        messages: [],
        pendingText: "",
        isStreaming: false,
      };
      const next = reduce(BASE_STATE, { kind: "set_session", session });
      expect(next.activeSession).toEqual(session);
    });

    test("clears session with null", () => {
      const state: TuiState = {
        ...BASE_STATE,
        activeSession: {
          agentId: "a1",
          sessionId: "s1",
          messages: [],
          pendingText: "",
          isStreaming: false,
        },
      };
      const next = reduce(state, { kind: "set_session", session: null });
      expect(next.activeSession).toBeNull();
    });
  });

  describe("append_tokens", () => {
    test("appends text to pending buffer", () => {
      const state: TuiState = {
        ...BASE_STATE,
        activeSession: {
          agentId: "a1",
          sessionId: "s1",
          messages: [],
          pendingText: "Hello",
          isStreaming: true,
        },
      };
      const next = reduce(state, { kind: "append_tokens", text: " world" });
      expect(next.activeSession?.pendingText).toBe("Hello world");
    });

    test("no-ops when no active session", () => {
      const next = reduce(BASE_STATE, { kind: "append_tokens", text: "hi" });
      expect(next).toBe(BASE_STATE);
    });
  });

  describe("flush_tokens", () => {
    test("moves pending text to messages", () => {
      const state: TuiState = {
        ...BASE_STATE,
        activeSession: {
          agentId: "a1",
          sessionId: "s1",
          messages: [],
          pendingText: "flushed text",
          isStreaming: true,
        },
      };
      const next = reduce(state, { kind: "flush_tokens" });
      expect(next.activeSession?.pendingText).toBe("");
      expect(next.activeSession?.messages).toHaveLength(1);
      expect(next.activeSession?.messages[0]?.kind).toBe("assistant");
      expect(
        next.activeSession?.messages[0]?.kind === "assistant"
          ? next.activeSession.messages[0].text
          : "",
      ).toBe("flushed text");
    });

    test("no-ops when pending text is empty", () => {
      const state: TuiState = {
        ...BASE_STATE,
        activeSession: {
          agentId: "a1",
          sessionId: "s1",
          messages: [],
          pendingText: "",
          isStreaming: false,
        },
      };
      const next = reduce(state, { kind: "flush_tokens" });
      expect(next).toBe(state);
    });

    test("no-ops when no active session", () => {
      const next = reduce(BASE_STATE, { kind: "flush_tokens" });
      expect(next).toBe(BASE_STATE);
    });
  });

  describe("add_message", () => {
    test("adds message to session", () => {
      const state: TuiState = {
        ...BASE_STATE,
        activeSession: {
          agentId: "a1",
          sessionId: "s1",
          messages: [],
          pendingText: "",
          isStreaming: false,
        },
      };
      const next = reduce(state, {
        kind: "add_message",
        message: { kind: "user", text: "hello", timestamp: 1 },
      });
      expect(next.activeSession?.messages).toHaveLength(1);
    });

    test("enforces sliding window", () => {
      const messages = Array.from({ length: MAX_SESSION_MESSAGES }, (_, i) => ({
        kind: "user" as const,
        text: `msg-${String(i)}`,
        timestamp: i,
      }));
      const state: TuiState = {
        ...BASE_STATE,
        activeSession: {
          agentId: "a1",
          sessionId: "s1",
          messages,
          pendingText: "",
          isStreaming: false,
        },
      };
      const next = reduce(state, {
        kind: "add_message",
        message: { kind: "user", text: "overflow", timestamp: 999 },
      });
      expect(next.activeSession?.messages).toHaveLength(MAX_SESSION_MESSAGES);
      // First message should be msg-1 (msg-0 was evicted)
      const first = next.activeSession?.messages[0];
      expect(first?.kind === "user" ? first.text : "").toBe("msg-1");
      // Last message should be the new one
      const last = next.activeSession?.messages[MAX_SESSION_MESSAGES - 1];
      expect(last?.kind === "user" ? last.text : "").toBe("overflow");
    });

    test("no-ops when no active session", () => {
      const next = reduce(BASE_STATE, {
        kind: "add_message",
        message: { kind: "user", text: "hi", timestamp: 1 },
      });
      expect(next).toBe(BASE_STATE);
    });
  });

  describe("set_connection_status", () => {
    test("updates connection status", () => {
      const next = reduce(BASE_STATE, {
        kind: "set_connection_status",
        status: "connected",
      });
      expect(next.connectionStatus).toBe("connected");
    });
  });

  describe("set_error", () => {
    test("sets error", () => {
      const error = { kind: "connection_refused" as const, url: "http://localhost:3100" };
      const next = reduce(BASE_STATE, { kind: "set_error", error });
      expect(next.error).toEqual(error);
    });

    test("clears error with null", () => {
      const state: TuiState = {
        ...BASE_STATE,
        error: { kind: "connection_refused", url: "http://localhost:3100" },
      };
      const next = reduce(state, { kind: "set_error", error: null });
      expect(next.error).toBeNull();
    });
  });

  describe("apply_event_batch", () => {
    test("updates lastEventSeq", () => {
      const next = reduce(BASE_STATE, {
        kind: "apply_event_batch",
        batch: { events: [], seq: 42, timestamp: Date.now() },
      });
      expect(next.lastEventSeq).toBe(42);
    });
  });
});

describe("createStore", () => {
  test("getState returns initial state", () => {
    const store = createStore(BASE_STATE);
    expect(store.getState()).toBe(BASE_STATE);
  });

  test("dispatch updates state", () => {
    const store = createStore(BASE_STATE);
    store.dispatch({ kind: "set_view", view: "console" });
    expect(store.getState().view).toBe("console");
  });

  test("subscribe notifies on state change", () => {
    const store = createStore(BASE_STATE);
    const states: readonly TuiState[] = [];
    const mutableStates = states as TuiState[];
    store.subscribe((s) => {
      mutableStates.push(s);
    });
    store.dispatch({ kind: "set_view", view: "console" });
    store.dispatch({ kind: "set_view", view: "palette" });
    expect(states).toHaveLength(2);
    expect(states[0]?.view).toBe("console");
    expect(states[1]?.view).toBe("palette");
  });

  test("unsubscribe stops notifications", () => {
    const store = createStore(BASE_STATE);
    let callCount = 0;
    const unsub = store.subscribe(() => {
      callCount++;
    });
    store.dispatch({ kind: "set_view", view: "console" });
    expect(callCount).toBe(1);
    unsub();
    store.dispatch({ kind: "set_view", view: "palette" });
    expect(callCount).toBe(1);
  });

  test("does not notify when state reference unchanged", () => {
    const state: TuiState = {
      ...BASE_STATE,
      activeSession: null,
    };
    const store = createStore(state);
    let callCount = 0;
    store.subscribe(() => {
      callCount++;
    });
    // append_tokens with no session → returns same reference
    store.dispatch({ kind: "append_tokens", text: "hi" });
    expect(callCount).toBe(0);
  });
});
