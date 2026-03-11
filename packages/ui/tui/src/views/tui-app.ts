/**
 * TUI application — wires views, store, clients, and pi-tui together.
 *
 * Owns the TUI instance, manages view switching, input routing,
 * store subscriptions, AG-UI streaming, and SSE event feed.
 */

import type { AgentDashboardEvent, DashboardEventBatch } from "@koi/dashboard-types";
import { isAgentEvent } from "@koi/dashboard-types";
import {
  Key,
  matchesKey,
  type OverlayHandle,
  ProcessTerminal,
  type SelectItem,
  SelectList,
  Spacer,
  TUI,
} from "@mariozechner/pi-tui";
import { type AdminClient, type ClientResult, createAdminClient } from "../client/admin-client.js";
import { type AguiStreamHandle, startChatStream } from "../client/agui-client.js";
import { createReconnectingStream, type ReconnectHandle } from "../client/reconnect.js";
import { createStore, type TuiStore } from "../state/store.js";
import { type ChatMessage, createInitialState, type TuiView } from "../state/types.js";
import { KOI_SELECT_THEME } from "../theme.js";
import { createAgentListView } from "./agent-list-view.js";
import { createAguiEventHandler } from "./agui-event-handler.js";
import { createCommandPalette } from "./command-palette.js";
import { createConsoleView } from "./console-view.js";
import { createSessionPicker, parseTuiChatLog, TUI_SESSION_PREFIX } from "./session-picker.js";
import { createStatusBar, type StatusBarData } from "./status-bar.js";

/** Configuration for the TUI application. */
export interface TuiAppConfig {
  readonly adminUrl: string;
  readonly authToken?: string;
  /** Refresh interval for agent list in ms (default: 5000). */
  readonly refreshIntervalMs?: number;
  /** Auto-attach to this agent on launch. */
  readonly initialAgentId?: string;
  /** Resume a specific session (requires initialAgentId). */
  readonly initialSessionId?: string;
}

/** Handle returned from createTuiApp for lifecycle management. */
export interface TuiAppHandle {
  /** Start the TUI — enters raw mode, renders first frame. */
  readonly start: () => Promise<void>;
  /** Stop the TUI — restores terminal, cleans up resources. */
  readonly stop: () => Promise<void>;
  /** The underlying store (for testing/integration). */
  readonly store: TuiStore;
}

/** Create and wire the complete TUI application. */
export function createTuiApp(config: TuiAppConfig): TuiAppHandle {
  const {
    adminUrl,
    authToken,
    refreshIntervalMs = 5_000,
    initialAgentId,
    initialSessionId,
  } = config;

  // ─── State ──────────────────────────────────────────────────────────
  const store = createStore(createInitialState(adminUrl));

  // ─── Admin client ───────────────────────────────────────────────────
  const clientConfig =
    authToken !== undefined ? { baseUrl: adminUrl, authToken } : { baseUrl: adminUrl };
  const client: AdminClient = createAdminClient(clientConfig);

  // ─── Terminal + TUI ─────────────────────────────────────────────────
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal, true);

  // ─── Active stream handles ──────────────────────────────────────────
  let activeChatStream: AguiStreamHandle | null = null;
  let sseStream: ReconnectHandle | null = null;

  const aguiHandler = createAguiEventHandler(store);

  // ─── Views ──────────────────────────────────────────────────────────
  const statusBar = createStatusBar();
  const agentList = createAgentListView({
    onSelect: (agentId) => {
      openAgentConsole(agentId);
    },
    onCancel: () => {
      stop().catch(() => {});
    },
  });

  const consoleView = createConsoleView(tui, {
    onSendMessage: (text) => {
      // Intercept slash commands typed in the console
      if (text.startsWith("/")) {
        handleSlashCommand(text);
        return;
      }
      sendChatMessage(text);
    },
    onEscape: () => {
      cancelActiveStream();
      persistCurrentSession()
        .catch(() => {})
        .finally(() => {
          store.dispatch({ kind: "set_session", session: null });
          store.dispatch({ kind: "set_view", view: "agents" });
        });
    },
  });

  const palette = createCommandPalette({
    onSelect: (commandId) => {
      handleCommand(commandId);
      hidePalette();
    },
    onCancel: () => {
      hidePalette();
    },
  });

  // ─── Layout ─────────────────────────────────────────────────────────
  const divider = new Spacer(1);

  tui.addChild(statusBar.component);
  tui.addChild(divider);

  let activeViewComponent: { invalidate(): void; render(w: number): string[] } | null = null;
  let overlayHandle: OverlayHandle | null = null;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;

  // ─── Agent console wiring ──────────────────────────────────────────
  function openAgentConsole(agentId: string): void {
    cancelActiveStream();
    const sessionId = `session-${Date.now().toString(36)}`;
    store.dispatch({
      kind: "set_session",
      session: { agentId, sessionId, messages: [], pendingText: "", isStreaming: false },
    });
    store.dispatch({ kind: "set_view", view: "console" });
    const agent = store.getState().agents.find((a) => a.agentId === agentId);
    const label = agent !== undefined ? `${agent.name} (${agent.state})` : agentId;
    addLifecycleMessage(`Attached to agent ${label}`);
    fetchRecentAgentActivity(agentId).catch(() => {});
  }

  /** Fetch recent agent events and display them as lifecycle messages. */
  async function fetchRecentAgentActivity(agentId: string): Promise<void> {
    const result = await client.fsList(`/agents/${agentId}/events`);
    if (!result.ok || result.value.length === 0) return;
    const recent = result.value[result.value.length - 1];
    if (recent === undefined) return;
    const content = await client.fsRead(recent.path);
    if (!content.ok) return;
    const text = typeof content.value === "string" ? content.value : "";
    const tail = text
      .split("\n")
      .filter((l) => l.trim() !== "")
      .slice(-10);
    if (tail.length > 0) addLifecycleMessage(`Recent activity:\n${tail.join("\n")}`);
  }

  function sendChatMessage(text: string): void {
    const session = store.getState().activeSession;
    if (session === null) return;

    // Add user message to chat
    store.dispatch({
      kind: "add_message",
      message: { kind: "user", text, timestamp: Date.now() },
    });

    // Cancel any active stream
    cancelActiveStream();

    // Build history from existing messages
    const history = session.messages
      .filter(
        (m): m is Extract<ChatMessage, { readonly kind: "user" | "assistant" }> =>
          m.kind === "user" || m.kind === "assistant",
      )
      .map((m, i) => ({
        id: `h${String(i)}`,
        role: m.kind as "user" | "assistant",
        content: m.text,
      }));

    // AG-UI chat goes through the admin API per-agent endpoint:
    //   POST {adminUrl}/agents/{agentId}/chat → SSE stream
    const chatUrl = client.agentChatUrl(session.agentId);
    // Extract base URL and path from the full chat URL
    const chatUrlObj = new URL(chatUrl);
    const aguiBase = chatUrlObj.origin;
    const aguiPath = chatUrlObj.pathname;

    const aguiConfig =
      authToken !== undefined
        ? { baseUrl: aguiBase, path: aguiPath, authToken }
        : { baseUrl: aguiBase, path: aguiPath };

    // Start AG-UI stream
    activeChatStream = startChatStream(
      aguiConfig,
      {
        threadId: session.sessionId,
        runId: `run-${Date.now().toString(36)}`,
        message: text,
        history,
      },
      {
        onEvent: aguiHandler.handle,
        onClose: () => {
          // Flush any pending tokens
          store.dispatch({ kind: "flush_tokens" });
          store.dispatch({ kind: "set_streaming", isStreaming: false });
          activeChatStream = null;
          // Persist session after exchange completes
          persistCurrentSession().catch(() => {});
        },
        onError: (error) => {
          store.dispatch({ kind: "flush_tokens" });
          store.dispatch({ kind: "set_error", error });
          store.dispatch({
            kind: "add_message",
            message: {
              kind: "lifecycle",
              event: `Stream error: ${error.kind}`,
              timestamp: Date.now(),
            },
          });
          activeChatStream = null;
        },
      },
    );
  }

  function cancelActiveStream(): void {
    if (activeChatStream !== null) {
      activeChatStream.cancel();
      activeChatStream = null;
      store.dispatch({ kind: "flush_tokens" });
      store.dispatch({ kind: "set_streaming", isStreaming: false });
    }
  }

  // ─── SSE event stream ─────────────────────────────────────────────

  function startEventStream(): void {
    if (sseStream !== null) return;

    const eventsUrl = client.eventsUrl();
    const hdrs: Record<string, string> = {};
    if (authToken !== undefined) {
      hdrs.Authorization = `Bearer ${authToken}`;
    }

    sseStream = createReconnectingStream(
      async (lastEventId) => {
        const fetchHeaders: Record<string, string> = { ...hdrs };
        if (lastEventId !== undefined) {
          fetchHeaders["Last-Event-ID"] = lastEventId;
        }
        return fetch(eventsUrl, { headers: fetchHeaders });
      },
      {
        onEvent: (event) => {
          // SSE events from admin API are DashboardEventBatch JSON
          try {
            const batch: unknown = JSON.parse(event.data);
            if (
              typeof batch === "object" &&
              batch !== null &&
              "events" in batch &&
              "seq" in batch &&
              "timestamp" in batch
            ) {
              const typedBatch = batch as DashboardEventBatch;
              store.dispatch({ kind: "apply_event_batch", batch: typedBatch });
              // Refresh agents on any agent event
              refreshAgents().catch(() => {});
              // Forward agent lifecycle events to the console if attached
              forwardAgentEventsToConsole(typedBatch);
            }
          } catch {
            // Malformed SSE data — skip
          }
        },
        onStatus: (status) => {
          switch (status.kind) {
            case "connected":
              store.dispatch({ kind: "set_connection_status", status: "connected" });
              break;
            case "reconnecting":
              store.dispatch({ kind: "set_connection_status", status: "reconnecting" });
              break;
            case "failed":
              store.dispatch({ kind: "set_connection_status", status: "disconnected" });
              break;
          }
        },
      },
      { maxAttempts: 10, initialDelayMs: 500, maxDelayMs: 10_000 },
    );
  }

  function stopEventStream(): void {
    if (sseStream !== null) {
      sseStream.stop();
      sseStream = null;
    }
  }

  // ─── View switching ─────────────────────────────────────────────────
  function switchView(view: TuiView): void {
    if (activeViewComponent !== null) {
      tui.removeChild(activeViewComponent);
      activeViewComponent = null;
    }

    switch (view) {
      case "agents":
        tui.addChild(agentList.component);
        tui.setFocus(agentList.component);
        activeViewComponent = agentList.component;
        break;
      case "console":
        tui.addChild(consoleView.container);
        tui.setFocus(consoleView.editor);
        activeViewComponent = consoleView.container;
        break;
      case "palette":
        break;
    }

    tui.requestRender();
  }

  function showPalette(): void {
    if (overlayHandle !== null) return;
    palette.reset();
    overlayHandle = tui.showOverlay(palette.component, {
      width: "60%",
      maxHeight: "50%",
      anchor: "top-center",
      offsetY: 3,
    });
    store.dispatch({ kind: "set_view", view: "palette" });
  }

  function hidePalette(): void {
    if (overlayHandle !== null) {
      overlayHandle.hide();
      overlayHandle = null;
    }
    const session = store.getState().activeSession;
    const targetView: TuiView = session !== null ? "console" : "agents";
    store.dispatch({ kind: "set_view", view: targetView });
  }

  // ─── Slash commands from console input ─────────────────────────────
  /** Parse and execute a slash command typed in the console input. */
  function handleSlashCommand(text: string): void {
    const parts = text.trim().split(/\s+/);
    const cmd = parts[0]?.slice(1); // strip leading "/"
    const arg = parts[1];

    if (cmd === "attach" && arg !== undefined) {
      // /attach <agentId> — attach to specific agent
      openAgentConsole(arg);
      return;
    }

    // Delegate to palette command handler for known commands
    if (cmd !== undefined) {
      handleCommand(cmd);
      return;
    }
    addLifecycleMessage(`Unknown command: ${text}`);
  }

  // ─── Command dispatch ───────────────────────────────────────────────
  function handleCommand(commandId: string): void {
    switch (commandId) {
      case "refresh":
        refreshAgents().catch(() => {});
        break;

      case "agents":
        cancelActiveStream();
        persistCurrentSession().catch(() => {});
        store.dispatch({ kind: "set_session", session: null });
        store.dispatch({ kind: "set_view", view: "agents" });
        break;

      case "attach":
        showAttachPicker();
        break;

      case "dispatch":
        dispatchNewAgent().catch(() => {});
        break;

      case "suspend":
        runAgentCommand("suspend", (id) => client.suspendAgent(id));
        break;

      case "resume":
        runAgentCommand("resume", (id) => client.resumeAgent(id));
        break;

      case "terminate":
        cancelActiveStream();
        runAgentCommand("terminate", (id) => client.terminateAgent(id));
        break;

      case "cancel":
        cancelActiveStream();
        addLifecycleMessage("Stream cancelled");
        break;

      case "sessions":
        sessionPicker.show().catch(() => {});
        break;

      case "logs":
        showAgentLogs().catch(() => {});
        break;

      case "health":
        client
          .checkHealth()
          .then((r) => {
            if (r.ok) {
              addLifecycleMessage(`Health: ${r.value.status}`);
            } else {
              addLifecycleMessage(`Health check failed: ${r.error.kind}`);
            }
          })
          .catch(() => {});
        break;

      case "open-browser":
        openInBrowser();
        break;

      case "quit":
        stop().catch(() => {});
        break;
    }
  }

  // ─── Command helpers ────────────────────────────────────────────────

  /** Run an agent lifecycle command (suspend/resume/terminate) on the active session. */
  function runAgentCommand(
    label: string,
    fn: (agentId: string) => Promise<ClientResult<null>>,
  ): void {
    const session = store.getState().activeSession;
    if (session === null) return;
    fn(session.agentId)
      .then((r) => {
        addLifecycleMessage(r.ok ? `Agent ${label}ed` : `${label} failed: ${r.error.kind}`);
        refreshAgents().catch(() => {});
      })
      .catch(() => {});
  }

  // ─── Command implementations ──────────────────────────────────────

  /** Forward SSE agent events to the console for the attached agent. */
  function forwardAgentEventsToConsole(batch: DashboardEventBatch): void {
    const session = store.getState().activeSession;
    if (session === null) return;

    for (const evt of batch.events) {
      if (!isAgentEvent(evt)) continue;
      if (evt.agentId !== session.agentId) continue;

      const desc = formatAgentEvent(evt);
      if (desc !== null) {
        addLifecycleMessage(desc);
      }
    }
  }

  /** Format an agent SSE event as a human-readable string. */
  function formatAgentEvent(evt: AgentDashboardEvent): string | null {
    switch (evt.subKind) {
      case "status_changed":
        return `Agent state: ${evt.from} → ${evt.to}`;
      case "dispatched":
        return `Agent dispatched: ${evt.name}`;
      case "terminated":
        return `Agent terminated${evt.reason !== undefined ? `: ${evt.reason}` : ""}`;
      case "metrics_updated":
        return `Turns: ${String(evt.turns)}, tokens: ${String(evt.tokenCount)}`;
      default:
        return null;
    }
  }

  function addLifecycleMessage(event: string): void {
    store.dispatch({
      kind: "add_message",
      message: { kind: "lifecycle", event, timestamp: Date.now() },
    });
  }

  async function dispatchNewAgent(): Promise<void> {
    const result = await client.dispatchAgent({
      name: `agent-${Date.now().toString(36)}`,
    });

    if (result.ok) {
      addLifecycleMessage(`Dispatched agent: ${result.value.name} (${result.value.agentId})`);
      await refreshAgents();
      openAgentConsole(result.value.agentId);
    } else {
      if (result.error.kind === "api_error" && result.error.code === "NOT_FOUND") {
        addLifecycleMessage("Dispatch not available — server does not support agent dispatch yet");
      } else {
        addLifecycleMessage(`Dispatch failed: ${result.error.kind}`);
      }
    }
  }

  /** Show an agent picker overlay for /attach. */
  function showAttachPicker(): void {
    const agents = store.getState().agents;
    if (agents.length === 0) {
      addLifecycleMessage("No agents available to attach to");
      return;
    }

    const items: SelectItem[] = agents.map((a) => ({
      value: a.agentId,
      label: `${a.name} (${a.state})`,
      description: a.agentId,
    }));

    const picker = new SelectList(items, Math.min(agents.length, 10), KOI_SELECT_THEME);
    picker.onSelect = (item: SelectItem) => {
      if (overlayHandle !== null) {
        overlayHandle.hide();
        overlayHandle = null;
      }
      openAgentConsole(item.value);
    };
    picker.onCancel = () => {
      if (overlayHandle !== null) {
        overlayHandle.hide();
        overlayHandle = null;
      }
    };

    overlayHandle = tui.showOverlay(picker, {
      width: "60%",
      maxHeight: "50%",
      anchor: "top-center",
      offsetY: 3,
    });
  }

  const sessionPicker = createSessionPicker({
    client,
    store,
    tui,
    addLifecycleMessage,
  });

  /** Persist the current session's messages to the admin filesystem. */
  async function persistCurrentSession(): Promise<void> {
    const session = store.getState().activeSession;
    if (session === null || session.messages.length === 0) return;

    const sessionPath = `/agents/${session.agentId}${TUI_SESSION_PREFIX}/${session.sessionId}.jsonl`;
    const content = session.messages.map((m) => JSON.stringify(m)).join("\n");

    // Best-effort write — don't block on failure
    await client.fsWrite(sessionPath, content).catch(() => {});
  }

  async function showAgentLogs(): Promise<void> {
    const session = store.getState().activeSession;
    if (session === null) {
      addLifecycleMessage("No active agent — select an agent first");
      return;
    }
    const result = await client.fsList(`/agents/${session.agentId}/events`);
    if (!result.ok) {
      addLifecycleMessage(`Failed to list logs: ${result.error.kind}`);
      return;
    }
    const recent = result.value[result.value.length - 1];
    if (recent === undefined) {
      addLifecycleMessage("No log entries found");
      return;
    }
    const content = await client.fsRead(recent.path);
    if (!content.ok) {
      addLifecycleMessage(`Failed to read log: ${content.error.kind}`);
      return;
    }
    const lines = (typeof content.value === "string" ? content.value : "").split("\n");
    addLifecycleMessage(`Recent logs:\n${lines.slice(-20).join("\n")}`);
  }

  function openInBrowser(): void {
    const session = store.getState().activeSession;
    const browserBase = adminUrl.replace(/\/api\/?$/, "");
    const browserUrl =
      session !== null
        ? `${browserBase}/browser?view=${encodeURIComponent(`/agents/${session.agentId}/session/${session.sessionId}`)}`
        : browserBase;
    addLifecycleMessage(`Opening: ${browserUrl}`);
    const openCmd =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    import("node:child_process")
      .then(({ execFile }) => {
        execFile(openCmd, [browserUrl]);
      })
      .catch(() => {
        addLifecycleMessage("Failed to open browser");
      });
  }

  // ─── Data fetching ──────────────────────────────────────────────────

  /** Load a saved TUI session's chat log. Returns empty array on failure. */
  async function loadSavedSession(
    agentId: string,
    sessionId: string,
  ): Promise<readonly ChatMessage[]> {
    const logPath = `/agents/${agentId}${TUI_SESSION_PREFIX}/${sessionId}.jsonl`;
    const result = await client.fsRead(logPath);
    if (!result.ok) return [];
    return parseTuiChatLog(typeof result.value === "string" ? result.value : "");
  }

  async function refreshAgents(): Promise<void> {
    const result = await client.listAgents();
    if (result.ok) {
      store.dispatch({ kind: "set_agents", agents: result.value });
    } else {
      store.dispatch({ kind: "set_error", error: result.error });
    }
  }

  // ─── Input handling ─────────────────────────────────────────────────
  tui.addInputListener((data: string) => {
    // Ctrl+P — toggle command palette
    if (matchesKey(data, Key.ctrl("p"))) {
      if (overlayHandle !== null) {
        hidePalette();
      } else {
        showPalette();
      }
      return { consume: true };
    }

    // Ctrl+R — refresh agents
    if (matchesKey(data, Key.ctrl("r"))) {
      refreshAgents().catch(() => {});
      return { consume: true };
    }

    // Ctrl+O — open in browser
    if (matchesKey(data, Key.ctrl("o"))) {
      openInBrowser();
      return { consume: true };
    }

    // q — quit (only in agent list view, not when typing)
    if (store.getState().view === "agents" && data === "q") {
      stop().catch(() => {});
      return { consume: true };
    }

    // Escape — back to agent list from console
    if (matchesKey(data, Key.escape) && store.getState().view === "console") {
      cancelActiveStream();
      store.dispatch({ kind: "set_session", session: null });
      store.dispatch({ kind: "set_view", view: "agents" });
      return { consume: true };
    }

    return { consume: false };
  });

  // ─── Store subscription → render ───────────────────────────────────
  let prevView: TuiView | null = null;

  store.subscribe((state) => {
    // Update status bar
    const agentName =
      state.activeSession !== null
        ? state.agents.find((a) => a.agentId === state.activeSession?.agentId)?.name
        : undefined;
    const statusData: StatusBarData = {
      connectionStatus: state.connectionStatus,
      agentName,
      view: state.view,
      agentCount: state.agents.length,
    };
    statusBar.update(statusData);

    // Switch views if changed
    if (state.view !== prevView && state.view !== "palette") {
      switchView(state.view);
      prevView = state.view;
    }

    // Update active view data
    if (state.view === "agents") {
      agentList.update(state.agents);
    } else if (state.view === "console") {
      consoleView.update(state.activeSession);
    }

    tui.requestRender();
  });

  // ─── Lifecycle ──────────────────────────────────────────────────────
  async function start(): Promise<void> {
    tui.start();

    // Initial connection attempt
    store.dispatch({ kind: "set_connection_status", status: "reconnecting" });

    const healthResult = await client.checkHealth();
    if (healthResult.ok) {
      store.dispatch({ kind: "set_connection_status", status: "connected" });
    } else {
      store.dispatch({ kind: "set_connection_status", status: "disconnected" });
      store.dispatch({ kind: "set_error", error: healthResult.error });
    }

    // Initial agent fetch
    await refreshAgents();

    // Start SSE event stream for live updates
    startEventStream();

    // Auto-attach to agent if --agent was specified
    if (initialAgentId !== undefined) {
      if (initialSessionId !== undefined) {
        // Resume specific session — load saved chat history
        const messages = await loadSavedSession(initialAgentId, initialSessionId);
        store.dispatch({
          kind: "set_session",
          session: {
            agentId: initialAgentId,
            sessionId: initialSessionId,
            messages,
            pendingText: "",
            isStreaming: false,
          },
        });
        store.dispatch({ kind: "set_view", view: "console" });
        const msgCount = messages.length > 0 ? ` (${String(messages.length)} messages)` : "";
        addLifecycleMessage(`Resumed session ${initialSessionId}${msgCount}`);
        fetchRecentAgentActivity(initialAgentId).catch(() => {});
      } else {
        openAgentConsole(initialAgentId);
      }
    } else {
      // Start with agent list view
      switchView("agents");
    }
    tui.requestRender();

    // Periodic agent refresh as fallback
    refreshTimer = setInterval(() => {
      refreshAgents().catch(() => {});
    }, refreshIntervalMs);
  }

  async function stop(): Promise<void> {
    if (refreshTimer !== undefined) {
      clearInterval(refreshTimer);
      refreshTimer = undefined;
    }
    cancelActiveStream();
    await persistCurrentSession().catch(() => {});
    stopEventStream();
    tui.stop();
    await terminal.drainInput(100, 50);
  }

  return { start, stop, store };
}
