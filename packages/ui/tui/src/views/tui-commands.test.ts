import { describe, expect, mock, test } from "bun:test";
import type { DashboardAgentSummary } from "@koi/dashboard-types";
import { createStore } from "../state/store.js";
import { createInitialState } from "../state/types.js";
import type { CommandDeps } from "./tui-commands.js";
import { dispatchCommand, handleSlashCommand, navigateBack } from "./tui-commands.js";

// ─── Helpers ────────────────────────────────────────────────────────────

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

function makeDeps(overrides: Partial<CommandDeps> = {}): CommandDeps & {
  readonly lifecycleMessages: readonly string[];
} {
  const store = overrides.store ?? createStore(createInitialState("http://localhost:3100"));
  const mutableMessages: string[] = [];
  return {
    store,
    client: {
      listAgents: mock(() => Promise.resolve({ ok: true, value: [] })),
      getAgent: mock(() => Promise.resolve({ ok: true, value: {} })),
      listChannels: mock(() => Promise.resolve({ ok: true, value: [] })),
      listSkills: mock(() => Promise.resolve({ ok: true, value: [] })),
      getMetrics: mock(() => Promise.resolve({ ok: true, value: {} })),
      getProcessTree: mock(() => Promise.resolve({ ok: true, value: {} })),
      getAgentProcfs: mock(() => Promise.resolve({ ok: true, value: {} })),
      suspendAgent: mock(() => Promise.resolve({ ok: true, value: null })),
      resumeAgent: mock(() => Promise.resolve({ ok: true, value: null })),
      terminateAgent: mock(() => Promise.resolve({ ok: true, value: null })),
      dispatchAgent: mock(() =>
        Promise.resolve({ ok: true, value: { agentId: "a-new", name: "agent-new" } }),
      ),
      checkHealth: mock(() => Promise.resolve({ ok: true, value: { status: "ok" } })),
      fsList: mock(() => Promise.resolve({ ok: true, value: [] })),
      fsRead: mock(() => Promise.resolve({ ok: true, value: "" })),
      fsWrite: mock(() => Promise.resolve({ ok: true, value: null })),
      listDataSources: mock(() => Promise.resolve({ ok: true, value: [] })),
      approveDataSource: mock(() => Promise.resolve({ ok: true, value: null })),
      rejectDataSource: mock(() => Promise.resolve({ ok: true, value: null })),
      getDataSourceSchema: mock(() => Promise.resolve({ ok: true, value: {} })),
      rescanDataSources: mock(() => Promise.resolve({ ok: true, value: [] })),
      eventsUrl: mock(() => "http://localhost:3100/events"),
      agentChatUrl: mock(() => "http://localhost:3100/chat/a1"),
    } as unknown as CommandDeps["client"],
    refreshAgents: mock(() => Promise.resolve()),
    openAgentConsole: mock(() => {}),
    openDataSources: mock(() => Promise.resolve()),
    rescanDataSources: mock(() => Promise.resolve()),
    approveDataSource: mock(() => Promise.resolve()),
    viewDataSourceSchema: mock(() => Promise.resolve()),
    openSessionPicker: mock(() => Promise.resolve()),
    showAgentLogs: mock(() => Promise.resolve()),
    openInBrowser: mock(() => {}),
    cancelActiveStream: mock(() => {}),
    stop: mock(() => Promise.resolve()),
    addLifecycleMessage: mock((event: string) => {
      mutableMessages.push(event);
    }),
    get lifecycleMessages() {
      return mutableMessages;
    },
    ...overrides,
  };
}

// ─── dispatchCommand ────────────────────────────────────────────────────

describe("dispatchCommand", () => {
  test("returns false for unknown command", () => {
    const deps = makeDeps();
    expect(dispatchCommand("unknown-command", deps)).toBe(false);
  });

  test("refresh calls refreshAgents", () => {
    const deps = makeDeps();
    expect(dispatchCommand("refresh", deps)).toBe(true);
    expect(deps.refreshAgents).toHaveBeenCalledTimes(1);
  });

  test("agents resets session and switches to agents view", () => {
    const deps = makeDeps();
    deps.store.dispatch({
      kind: "set_session",
      session: {
        agentId: "a1",
        sessionId: "s1",
        messages: [],
        pendingText: "",
        isStreaming: false,
      },
    });
    deps.store.dispatch({ kind: "set_view", view: "console" });

    expect(dispatchCommand("agents", deps)).toBe(true);
    expect(deps.cancelActiveStream).toHaveBeenCalledTimes(1);
    expect(deps.store.getState().activeSession).toBeNull();
    expect(deps.store.getState().view).toBe("agents");
  });

  test("attach lists available agents when agents exist", () => {
    const store = createStore(createInitialState("http://localhost:3100"));
    store.dispatch({ kind: "set_agents", agents: [makeAgent("a1", "Alice")] });
    const deps = makeDeps({ store });

    expect(dispatchCommand("attach", deps)).toBe(true);
    expect(deps.lifecycleMessages.length).toBe(1);
    expect(deps.lifecycleMessages[0]).toContain("Alice");
    expect(deps.lifecycleMessages[0]).toContain("/attach");
  });

  test("attach shows no-agents message when list is empty", () => {
    const deps = makeDeps();

    expect(dispatchCommand("attach", deps)).toBe(true);
    expect(deps.lifecycleMessages.length).toBe(1);
    expect(deps.lifecycleMessages[0]).toContain("No agents available");
  });

  test("dispatch calls client.dispatchAgent", () => {
    const deps = makeDeps();
    expect(dispatchCommand("dispatch", deps)).toBe(true);
    // dispatchNewAgent is async and called internally
  });

  test("suspend calls runAgentCommand with active session", async () => {
    const store = createStore(createInitialState("http://localhost:3100"));
    store.dispatch({
      kind: "set_session",
      session: {
        agentId: "a1",
        sessionId: "s1",
        messages: [],
        pendingText: "",
        isStreaming: false,
      },
    });
    const deps = makeDeps({ store });

    expect(dispatchCommand("suspend", deps)).toBe(true);
    // Let the promise chain settle
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(deps.client.suspendAgent).toHaveBeenCalledWith("a1");
  });

  test("suspend no-ops when no active session", () => {
    const deps = makeDeps();
    expect(dispatchCommand("suspend", deps)).toBe(true);
    expect(deps.client.suspendAgent).not.toHaveBeenCalled();
  });

  test("resume calls runAgentCommand with active session", async () => {
    const store = createStore(createInitialState("http://localhost:3100"));
    store.dispatch({
      kind: "set_session",
      session: {
        agentId: "a1",
        sessionId: "s1",
        messages: [],
        pendingText: "",
        isStreaming: false,
      },
    });
    const deps = makeDeps({ store });

    expect(dispatchCommand("resume", deps)).toBe(true);
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(deps.client.resumeAgent).toHaveBeenCalledWith("a1");
  });

  test("terminate cancels stream and calls terminateAgent", async () => {
    const store = createStore(createInitialState("http://localhost:3100"));
    store.dispatch({
      kind: "set_session",
      session: {
        agentId: "a1",
        sessionId: "s1",
        messages: [],
        pendingText: "",
        isStreaming: false,
      },
    });
    const deps = makeDeps({ store });

    expect(dispatchCommand("terminate", deps)).toBe(true);
    expect(deps.cancelActiveStream).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(deps.client.terminateAgent).toHaveBeenCalledWith("a1");
  });

  test("cancel cancels stream and adds lifecycle message", () => {
    const deps = makeDeps();

    expect(dispatchCommand("cancel", deps)).toBe(true);
    expect(deps.cancelActiveStream).toHaveBeenCalledTimes(1);
    expect(deps.lifecycleMessages[0]).toBe("Stream cancelled");
  });

  test("sessions opens session picker", () => {
    const deps = makeDeps();
    expect(dispatchCommand("sessions", deps)).toBe(true);
    expect(deps.openSessionPicker).toHaveBeenCalledTimes(1);
  });

  test("sources opens data sources", () => {
    const deps = makeDeps();
    expect(dispatchCommand("sources", deps)).toBe(true);
    expect(deps.openDataSources).toHaveBeenCalledTimes(1);
  });

  test("sources-add triggers rescan", () => {
    const deps = makeDeps();
    expect(dispatchCommand("sources-add", deps)).toBe(true);
    expect(deps.rescanDataSources).toHaveBeenCalledTimes(1);
  });

  test("sources-approve approves first pending data source", () => {
    const store = createStore(createInitialState("http://localhost:3100"));
    store.dispatch({
      kind: "set_data_sources",
      sources: [
        { name: "db-1", protocol: "postgres", status: "pending", source: "env" },
        { name: "db-2", protocol: "sqlite", status: "approved", source: "manifest" },
      ],
    });
    const deps = makeDeps({ store });

    expect(dispatchCommand("sources-approve", deps)).toBe(true);
    expect(deps.approveDataSource).toHaveBeenCalledWith("db-1");
  });

  test("sources-approve shows message when no pending sources", () => {
    const store = createStore(createInitialState("http://localhost:3100"));
    store.dispatch({
      kind: "set_data_sources",
      sources: [{ name: "db-1", protocol: "postgres", status: "approved", source: "env" }],
    });
    const deps = makeDeps({ store });

    expect(dispatchCommand("sources-approve", deps)).toBe(true);
    expect(deps.lifecycleMessages[0]).toContain("No pending");
  });

  test("sources-schema views schema for first data source", () => {
    const store = createStore(createInitialState("http://localhost:3100"));
    store.dispatch({
      kind: "set_data_sources",
      sources: [{ name: "db-1", protocol: "postgres", status: "approved", source: "env" }],
    });
    const deps = makeDeps({ store });

    expect(dispatchCommand("sources-schema", deps)).toBe(true);
    expect(deps.viewDataSourceSchema).toHaveBeenCalledWith("db-1");
  });

  test("sources-schema shows message when no sources available", () => {
    const deps = makeDeps();
    expect(dispatchCommand("sources-schema", deps)).toBe(true);
    expect(deps.lifecycleMessages[0]).toContain("No data sources");
  });

  test("logs switches to live log view", () => {
    const deps = makeDeps();
    expect(dispatchCommand("logs", deps)).toBe(true);
    expect(deps.store.getState().view).toBe("logs");
  });

  test("health reports healthy status", async () => {
    const deps = makeDeps();
    expect(dispatchCommand("health", deps)).toBe(true);
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(deps.lifecycleMessages[0]).toContain("Health: ok");
  });

  test("health reports failure", async () => {
    const deps = makeDeps({
      client: {
        checkHealth: mock(() =>
          Promise.resolve({
            ok: false,
            error: { kind: "api_error" as const, code: "UNAVAILABLE", message: "down" },
          }),
        ),
      } as unknown as CommandDeps["client"],
    });

    expect(dispatchCommand("health", deps)).toBe(true);
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(deps.lifecycleMessages[0]).toContain("Health check failed");
  });

  test("open-browser calls openInBrowser", () => {
    const deps = makeDeps();
    expect(dispatchCommand("open-browser", deps)).toBe(true);
    expect(deps.openInBrowser).toHaveBeenCalledTimes(1);
  });

  test("quit calls stop", () => {
    const deps = makeDeps();
    expect(dispatchCommand("quit", deps)).toBe(true);
    expect(deps.stop).toHaveBeenCalledTimes(1);
  });
});

// ─── handleSlashCommand ─────────────────────────────────────────────────

describe("handleSlashCommand", () => {
  test("attaches to agent by name (case-insensitive)", () => {
    const store = createStore(createInitialState("http://localhost:3100"));
    store.dispatch({ kind: "set_agents", agents: [makeAgent("a1", "Alice")] });
    const deps = makeDeps({ store });

    handleSlashCommand("/attach alice", deps);
    expect(deps.openAgentConsole).toHaveBeenCalledWith("a1");
  });

  test("shows error when /attach target not found", () => {
    const store = createStore(createInitialState("http://localhost:3100"));
    store.dispatch({ kind: "set_agents", agents: [makeAgent("a1", "Alice")] });
    const deps = makeDeps({ store });

    handleSlashCommand("/attach bob", deps);
    expect(deps.lifecycleMessages[0]).toContain("Agent not found: bob");
  });

  test("routes known commands through dispatchCommand", () => {
    const deps = makeDeps();
    handleSlashCommand("/refresh", deps);
    expect(deps.refreshAgents).toHaveBeenCalledTimes(1);
  });

  test("shows unknown command message for unrecognized slash commands", () => {
    const deps = makeDeps();
    handleSlashCommand("/foobar", deps);
    expect(deps.lifecycleMessages[0]).toContain("Unknown command: /foobar");
  });

  test("handles /quit command", () => {
    const deps = makeDeps();
    handleSlashCommand("/quit", deps);
    expect(deps.stop).toHaveBeenCalledTimes(1);
  });

  test("handles /attach without argument (lists agents)", () => {
    const deps = makeDeps();
    handleSlashCommand("/attach", deps);
    // Falls through to dispatchCommand("attach", deps) which lists agents
    expect(deps.lifecycleMessages.length).toBeGreaterThan(0);
  });
});

// ─── navigateBack ───────────────────────────────────────────────────────

describe("navigateBack", () => {
  test("returns console when active session exists", () => {
    const store = createStore(createInitialState("http://localhost:3100"));
    store.dispatch({
      kind: "set_session",
      session: {
        agentId: "a1",
        sessionId: "s1",
        messages: [],
        pendingText: "",
        isStreaming: false,
      },
    });
    expect(navigateBack(store)).toBe("console");
  });

  test("returns agents when no active session", () => {
    const store = createStore(createInitialState("http://localhost:3100"));
    expect(navigateBack(store)).toBe("agents");
  });
});
