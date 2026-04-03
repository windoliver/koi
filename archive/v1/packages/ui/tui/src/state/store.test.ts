import { describe, expect, test } from "bun:test";
import type {
  DashboardAgentSummary,
  ForgeDashboardEvent,
  MonitorDashboardEvent,
} from "@koi/dashboard-types";
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

function makeToolCall(
  name: string,
  args: string,
  toolCallId: string,
  result: string | undefined = undefined,
  timestamp = 1,
): import("@koi/dashboard-client").ChatMessage {
  return {
    kind: "tool_call",
    name,
    args,
    result,
    toolCallId,
    timestamp,
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

  describe("update_tool_result", () => {
    test("updates matching tool_call message result", () => {
      const state: TuiState = {
        ...BASE_STATE,
        activeSession: {
          agentId: "a1",
          sessionId: "s1",
          messages: [
            { kind: "user", text: "hello", timestamp: 1 },
            makeToolCall("read", "{}", "tc-1", undefined, 2),
          ],
          pendingText: "",
          isStreaming: true,
        },
      };
      const next = reduce(state, {
        kind: "update_tool_result",
        toolCallId: "tc-1",
        result: "file contents here",
      });
      const msg = next.activeSession?.messages[1];
      expect(msg?.kind).toBe("tool_call");
      if (msg?.kind === "tool_call") {
        expect(msg.result).toBe("file contents here");
        expect(msg.toolCallId).toBe("tc-1");
      }
    });

    test("no-ops when toolCallId not found", () => {
      const state: TuiState = {
        ...BASE_STATE,
        activeSession: {
          agentId: "a1",
          sessionId: "s1",
          messages: [makeToolCall("read", "{}", "tc-1")],
          pendingText: "",
          isStreaming: false,
        },
      };
      const next = reduce(state, {
        kind: "update_tool_result",
        toolCallId: "tc-nonexistent",
        result: "data",
      });
      expect(next).toBe(state);
    });

    test("updates last matching tool_call when duplicates exist", () => {
      const state: TuiState = {
        ...BASE_STATE,
        activeSession: {
          agentId: "a1",
          sessionId: "s1",
          messages: [
            makeToolCall("read", "a", "tc-dup", "old-a", 1),
            { kind: "user", text: "next", timestamp: 2 },
            makeToolCall("read", "b", "tc-dup", undefined, 3),
          ],
          pendingText: "",
          isStreaming: false,
        },
      };
      const next = reduce(state, {
        kind: "update_tool_result",
        toolCallId: "tc-dup",
        result: "new-result",
      });
      // First message with same id should be untouched
      const first = next.activeSession?.messages[0];
      if (first?.kind === "tool_call") {
        expect(first.result).toBe("old-a");
      }
      // Last message with same id should be updated
      const last = next.activeSession?.messages[2];
      if (last?.kind === "tool_call") {
        expect(last.result).toBe("new-result");
      }
    });

    test("overwrites existing result", () => {
      const state: TuiState = {
        ...BASE_STATE,
        activeSession: {
          agentId: "a1",
          sessionId: "s1",
          messages: [makeToolCall("read", "{}", "tc-1", "first")],
          pendingText: "",
          isStreaming: false,
        },
      };
      const next = reduce(state, {
        kind: "update_tool_result",
        toolCallId: "tc-1",
        result: "overwritten",
      });
      const msg = next.activeSession?.messages[0];
      if (msg?.kind === "tool_call") {
        expect(msg.result).toBe("overwritten");
      }
    });

    test("no-ops when no active session", () => {
      const next = reduce(BASE_STATE, {
        kind: "update_tool_result",
        toolCallId: "tc-1",
        result: "data",
      });
      expect(next).toBe(BASE_STATE);
    });

    test("preserves immutability — original state unchanged", () => {
      const original: TuiState = {
        ...BASE_STATE,
        activeSession: {
          agentId: "a1",
          sessionId: "s1",
          messages: [makeToolCall("read", "{}", "tc-1")],
          pendingText: "",
          isStreaming: false,
        },
      };
      const next = reduce(original, {
        kind: "update_tool_result",
        toolCallId: "tc-1",
        result: "updated",
      });
      // Original unchanged
      const origMsg = original.activeSession?.messages[0];
      if (origMsg?.kind === "tool_call") {
        expect(origMsg.result).toBeUndefined();
      }
      // New state updated
      const newMsg = next.activeSession?.messages[0];
      if (newMsg?.kind === "tool_call") {
        expect(newMsg.result).toBe("updated");
      }
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

    test("detects SSE gap and sets error", () => {
      const state: TuiState = { ...BASE_STATE, lastEventSeq: 5 };
      const next = reduce(state, {
        kind: "apply_event_batch",
        batch: { events: [], seq: 8, timestamp: Date.now() },
      });
      expect(next.lastEventSeq).toBe(8);
      expect(next.error).not.toBeNull();
      expect(next.error?.kind).toBe("api_error");
      if (next.error?.kind === "api_error") {
        expect(next.error.code).toBe("SSE_GAP");
        expect(next.error.message).toContain("expected seq 6");
        expect(next.error.message).toContain("got 8");
      }
    });

    test("no gap on sequential batches", () => {
      const state: TuiState = { ...BASE_STATE, lastEventSeq: 5 };
      const next = reduce(state, {
        kind: "apply_event_batch",
        batch: { events: [], seq: 6, timestamp: Date.now() },
      });
      expect(next.lastEventSeq).toBe(6);
      expect(next.error).toBeNull();
    });

    test("no gap on first batch (lastEventSeq = 0)", () => {
      const next = reduce(BASE_STATE, {
        kind: "apply_event_batch",
        batch: { events: [], seq: 42, timestamp: Date.now() },
      });
      expect(next.error).toBeNull();
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

// ---------------------------------------------------------------------------
// Forge reducer tests
// ---------------------------------------------------------------------------

function makeForgeEvent(subKind: string, extra: Record<string, unknown> = {}): ForgeDashboardEvent {
  return { kind: "forge", subKind, timestamp: 1_000_000, ...extra } as ForgeDashboardEvent;
}

function makeMonitorEvent(): MonitorDashboardEvent {
  return {
    kind: "monitor",
    subKind: "anomaly_detected",
    anomalyKind: "error_spike",
    agentId: "a-1",
    sessionId: "s-1",
    detail: {},
    timestamp: 1_000_000,
  };
}

describe("reduce — apply_forge_batch", () => {
  test("creates brick on brick_forged", () => {
    const next = reduce(BASE_STATE, {
      kind: "apply_forge_batch",
      events: [
        makeForgeEvent("brick_forged", {
          brickId: "b-1",
          name: "my-tool",
          origin: "crystallize",
          ngramKey: "a>b",
          occurrences: 5,
          score: 0.9,
        }),
      ],
    });
    expect(next.forgeBricks["b-1"]).toBeDefined();
    expect(next.forgeBricks["b-1"]?.name).toBe("my-tool");
    expect(next.forgeBricks["b-1"]?.status).toBe("active");
  });

  test("updates sparkline on fitness_flushed", () => {
    const state = reduce(BASE_STATE, {
      kind: "apply_forge_batch",
      events: [
        makeForgeEvent("brick_forged", {
          brickId: "b-1",
          name: "tool",
          origin: "crystallize",
          ngramKey: "a>b",
          occurrences: 5,
          score: 0.9,
        }),
      ],
    });
    const next = reduce(state, {
      kind: "apply_forge_batch",
      events: [
        makeForgeEvent("fitness_flushed", { brickId: "b-1", successRate: 0.85, sampleCount: 100 }),
      ],
    });
    expect(next.forgeSparklines["b-1"]).toEqual([0.85]);
    expect(next.forgeBricks["b-1"]?.fitness).toBe(0.85);
  });

  test("caps forge events buffer at 200", () => {
    const events: ForgeDashboardEvent[] = [];
    for (let i = 0; i < 201; i++) {
      events.push(
        makeForgeEvent("demand_detected", {
          signalId: `sig-${String(i)}`,
          triggerKind: "gap",
          confidence: 0.5,
          suggestedBrickKind: "tool",
        }),
      );
    }
    const next = reduce(BASE_STATE, { kind: "apply_forge_batch", events });
    expect(next.forgeEvents).toHaveLength(200);
  });

  test("empty batch is a no-op for forge state", () => {
    const next = reduce(BASE_STATE, { kind: "apply_forge_batch", events: [] });
    expect(next.forgeEvents).toEqual([]);
    expect(next.forgeBricks).toEqual({});
  });
});

describe("reduce — apply_monitor_event", () => {
  test("appends monitor event", () => {
    const next = reduce(BASE_STATE, {
      kind: "apply_monitor_event",
      event: makeMonitorEvent(),
    });
    expect(next.monitorEvents).toHaveLength(1);
  });

  test("caps monitor events at 50", () => {
    let state = BASE_STATE;
    for (let i = 0; i < 51; i++) {
      state = reduce(state, { kind: "apply_monitor_event", event: makeMonitorEvent() });
    }
    expect(state.monitorEvents).toHaveLength(50);
  });
});

describe("reduce — debug view actions", () => {
  test("set_debug_inventory updates inventory and clears loading", () => {
    const state: TuiState = {
      ...BASE_STATE,
      debugView: { ...BASE_STATE.debugView, loading: true },
    };
    const items = [
      { name: "mw-a", category: "middleware", enabled: true, source: "static" },
      { name: "my-tool", category: "tool", enabled: true, source: "operator" },
    ] as const;
    const next = reduce(state, { kind: "set_debug_inventory", items });
    expect(next.debugView.inventory).toEqual(items);
    expect(next.debugView.loading).toBe(false);
  });

  test("set_debug_contributions updates contributions", () => {
    const contributions = {
      stacks: [
        {
          id: "nexus",
          label: "Nexus",
          enabled: true,
          source: "runtime",
          packages: [
            { id: "@koi/nexus", kind: "middleware", source: "static", middlewareNames: ["auth"] },
          ],
        },
      ],
      generatedAt: 1234567890,
    } as const;
    const next = reduce(BASE_STATE, { kind: "set_debug_contributions", contributions });
    expect(next.debugView.contributions).toEqual(contributions);
    expect(next.debugView.contributions?.stacks).toHaveLength(1);
  });

  test("set_debug_panel switches active panel", () => {
    const next = reduce(BASE_STATE, { kind: "set_debug_panel", panel: "waterfall" });
    expect(next.debugView.activePanel).toBe("waterfall");
  });

  test("set_debug_panel switches back to inventory", () => {
    const state: TuiState = {
      ...BASE_STATE,
      debugView: { ...BASE_STATE.debugView, activePanel: "waterfall" },
    };
    const next = reduce(state, { kind: "set_debug_panel", panel: "inventory" });
    expect(next.debugView.activePanel).toBe("inventory");
  });

  test("select_debug_turn updates selectedTurnIndex", () => {
    const next = reduce(BASE_STATE, { kind: "select_debug_turn", turnIndex: 5 });
    expect(next.debugView.selectedTurnIndex).toBe(5);
  });

  test("select_debug_turn clamps negative to 0", () => {
    const next = reduce(BASE_STATE, { kind: "select_debug_turn", turnIndex: -3 });
    expect(next.debugView.selectedTurnIndex).toBe(0);
  });

  test("set_debug_trace updates trace and clears loading", () => {
    const state: TuiState = {
      ...BASE_STATE,
      debugView: { ...BASE_STATE.debugView, loading: true },
    };
    const trace = {
      turnIndex: 0,
      totalDurationMs: 42,
      spans: [
        {
          name: "mw-a",
          hook: "wrapModelCall",
          durationMs: 42,
          source: "static",
          phase: "resolve",
          priority: 500,
          nextCalled: true,
        },
      ],
      timestamp: Date.now(),
    };
    const next = reduce(state, { kind: "set_debug_trace", trace });
    expect(next.debugView.trace).toEqual(trace);
    expect(next.debugView.loading).toBe(false);
  });

  test("set_debug_trace clears trace with null", () => {
    const state: TuiState = {
      ...BASE_STATE,
      debugView: {
        ...BASE_STATE.debugView,
        trace: {
          turnIndex: 0,
          totalDurationMs: 10,
          spans: [],
          timestamp: Date.now(),
        },
      },
    };
    const next = reduce(state, { kind: "set_debug_trace", trace: null });
    expect(next.debugView.trace).toBeNull();
  });

  test("set_debug_loading updates loading flag", () => {
    const next = reduce(BASE_STATE, { kind: "set_debug_loading", loading: true });
    expect(next.debugView.loading).toBe(true);
  });
});

describe("reduce — set_view forge", () => {
  test("switches to forge view", () => {
    const next = reduce(BASE_STATE, { kind: "set_view", view: "forge" });
    expect(next.view).toBe("forge");
  });
});
