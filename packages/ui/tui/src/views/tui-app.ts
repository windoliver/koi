/**
 * TUI application — wires views, store, clients, and OpenTUI together.
 *
 * Uses OpenTUI's CliRenderer with SolidJS reconciler for declarative UI.
 * Owns the renderer, manages view switching, input routing,
 * store subscriptions, AG-UI streaming, and SSE event feed.
 */

import {
  type AdminClient,
  type AguiStreamHandle,
  type ChatMessage,
  type ClientResult,
  createAdminClient,
  createDebounce,
  createReconnectingStream,
  parseSessionRecord,
  type ReconnectHandle,
  startChatStream,
} from "@koi/dashboard-client";
import type { AgentDashboardEvent, DashboardEventBatch } from "@koi/dashboard-types";
import { isAgentEvent } from "@koi/dashboard-types";
import { type CliRenderer, SyntaxStyle } from "@opentui/core";
import { render } from "@opentui/solid";
import { createSignal } from "solid-js";
import { createStore, type TuiStore } from "../state/store.js";
import { createInitialState, type TuiView } from "../state/types.js";
import { createAguiEventHandler } from "./agui-event-handler.js";
import type { SessionPickerEntry } from "./session-picker-view.js";
import { createKeyboardHandler } from "./tui-keyboard.js";
import { TuiRoot } from "./tui-root.js";
import { fetchRecentAgentActivity, persistCurrentSession, restoreSession } from "./tui-session.js";

/** Configuration for the TUI application. */
export interface TuiAppConfig {
  readonly adminUrl: string;
  readonly authToken?: string;
  /** Refresh interval for agent list in ms (default: 30000 — SSE is primary). */
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
  /** Handle console text input (messages or slash commands). */
  readonly handleConsoleInput: (text: string) => void;
  /** Handle palette command selection. */
  readonly handlePaletteSelect: (commandId: string) => void;
  /** Handle agent selection from the list. */
  readonly handleAgentSelect: (agentId: string) => void;
  /** Keyboard input handler for raw terminal sequences. */
  readonly handleKeyInput: (sequence: string) => boolean;
}

/**
 * Create and wire the complete TUI application.
 *
 * Coordinates state, clients, streams, and the OpenTUI rendering layer.
 * Calls render() from @opentui/solid in start() to enter raw mode,
 * and renderer.destroy() in stop() to restore the terminal.
 */
export function createTuiApp(config: TuiAppConfig): TuiAppHandle {
  const {
    adminUrl,
    authToken,
    refreshIntervalMs = 30_000,
    initialAgentId,
    initialSessionId,
  } = config;

  // ─── State ──────────────────────────────────────────────────────────
  const store = createStore(createInitialState(adminUrl));

  // ─── Admin client ───────────────────────────────────────────────────
  const clientConfig =
    authToken !== undefined ? { baseUrl: adminUrl, authToken } : { baseUrl: adminUrl };
  const client: AdminClient = createAdminClient(clientConfig);

  // ─── Active stream handles ──────────────────────────────────────────
  let activeChatStream: AguiStreamHandle | null = null;
  let sseStream: ReconnectHandle | null = null;
  let tuiRenderer: CliRenderer | null = null;
  let syntaxStyle: SyntaxStyle | null = null;

  const aguiHandler = createAguiEventHandler(store);

  // ─── Debounced operations ───────────────────────────────────────────
  const debouncedRefresh = createDebounce(() => {
    refreshAgents().catch(() => {});
  }, 300);

  const debouncedPersist = createDebounce(() => {
    persistCurrentSession(store, client).catch(() => {});
  }, 500);

  // ─── Session picker state ─────────────────────────────────────────
  const [sessions, setSessions] = createSignal<readonly SessionPickerEntry[]>([]);
  const [sessionsLoading, setSessionsLoading] = createSignal(false);

  // ─── Overlay state ──────────────────────────────────────────────────
  let paletteVisible = false;

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
    fetchRecentAgentActivity(client, store, agentId).catch(() => {});
  }

  function sendChatMessage(text: string): void {
    const session = store.getState().activeSession;
    if (session === null) return;

    store.dispatch({
      kind: "add_message",
      message: { kind: "user", text, timestamp: Date.now() },
    });

    cancelActiveStream();

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

    const chatUrl = client.agentChatUrl(session.agentId);
    const chatUrlObj = new URL(chatUrl);
    const aguiBase = chatUrlObj.origin;
    const aguiPath = chatUrlObj.pathname;

    const aguiConfig =
      authToken !== undefined
        ? { baseUrl: aguiBase, path: aguiPath, authToken }
        : { baseUrl: aguiBase, path: aguiPath };

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
          store.dispatch({ kind: "flush_tokens" });
          store.dispatch({ kind: "set_streaming", isStreaming: false });
          activeChatStream = null;
          debouncedPersist.call();
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
              // Debounced refresh on any agent event
              debouncedRefresh.call();
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

  // ─── Palette ───────────────────────────────────────────────────────

  function togglePalette(): void {
    if (paletteVisible) {
      hidePalette();
    } else {
      showPalette();
    }
  }

  function showPalette(): void {
    if (paletteVisible) return;
    paletteVisible = true;
    store.dispatch({ kind: "set_view", view: "palette" });
  }

  function hidePalette(): void {
    if (!paletteVisible) return;
    paletteVisible = false;
    const session = store.getState().activeSession;
    const targetView: TuiView = session !== null ? "console" : "agents";
    store.dispatch({ kind: "set_view", view: targetView });
  }

  // ─── Slash commands from console input ─────────────────────────────

  function handleSlashCommand(text: string): void {
    const parts = text.trim().split(/\s+/);
    const cmd = parts[0]?.slice(1);
    const arg = parts[1];

    if (cmd === "attach" && arg !== undefined) {
      openAgentConsole(arg);
      return;
    }

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
        debouncedPersist.flush();
        store.dispatch({ kind: "set_session", session: null });
        store.dispatch({ kind: "set_view", view: "agents" });
        break;

      case "attach": {
        // Show agent names in lifecycle message for easy selection
        const agentNames = store.getState().agents.map((a) => a.name);
        if (agentNames.length > 0) {
          addLifecycleMessage(
            `Available agents: ${agentNames.join(", ")}\nUse /attach <name> to connect`,
          );
        } else {
          addLifecycleMessage("No agents available. Use /dispatch to create one.");
        }
        break;
      }

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
        openSessionPicker().catch(() => {});
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
    const agentSessionPath =
      session !== null
        ? `/agents/${session.agentId}/session/records/${session.sessionId}.json`
        : null;
    const browserUrl =
      agentSessionPath !== null
        ? `${browserBase}/browser?view=agents&path=${encodeURIComponent(agentSessionPath)}`
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

  // ─── Session picker ────────────────────────────────────────────────

  async function openSessionPicker(): Promise<void> {
    setSessionsLoading(true);
    store.dispatch({ kind: "set_view", view: "sessions" });

    const agents = store.getState().agents;
    const entries: SessionPickerEntry[] = [];

    for (const agent of agents) {
      const listResult = await client.fsList(`/agents/${agent.agentId}/session/records`);
      if (!listResult.ok) continue;

      for (const file of listResult.value) {
        if (file.isDirectory || !file.name.endsWith(".json")) continue;

        const readResult = await client.fsRead(file.path);
        if (!readResult.ok) continue;

        const content = typeof readResult.value === "string" ? readResult.value : "";
        const parsed = parseSessionRecord(content);
        if (parsed === null) continue;

        entries.push({
          sessionId: parsed.sessionId,
          agentName: parsed.agentName,
          connectedAt: parsed.connectedAt,
          messageCount: 0,
        });
      }
    }

    // Sort by most recent first
    entries.sort((a, b) => b.connectedAt - a.connectedAt);
    setSessions(entries);
    setSessionsLoading(false);
  }

  function handleSessionSelect(sessionId: string): void {
    // Find which agent owns this session
    const entry = sessions().find((s) => s.sessionId === sessionId);
    if (entry === undefined) return;

    // Find the agent by name
    const agent = store.getState().agents.find((a) => a.name === entry.agentName);
    const agentId = agent !== undefined ? agent.agentId : entry.agentName;

    restoreSession(store, client, agentId, sessionId)
      .then((count) => {
        const label = `${String(count)} messages`;
        addLifecycleMessage(`Restored session ${sessionId} (${label})`);
      })
      .catch(() => {
        addLifecycleMessage(`Failed to restore session ${sessionId}`);
      });
  }

  function closeSessions(): void {
    store.dispatch({ kind: "set_view", view: "agents" });
  }

  // ─── Data fetching ──────────────────────────────────────────────────

  async function refreshAgents(): Promise<void> {
    const result = await client.listAgents();
    if (result.ok) {
      store.dispatch({ kind: "set_agents", agents: result.value });
    } else {
      store.dispatch({ kind: "set_error", error: result.error });
    }
  }

  // ─── Input handling ─────────────────────────────────────────────────
  const keyboardHandler = createKeyboardHandler(store, {
    togglePalette,
    refreshAgents: () => {
      refreshAgents().catch(() => {});
    },
    openInBrowser,
    stop: () => {
      stop().catch(() => {});
    },
    cancelAndGoBack: () => {
      cancelActiveStream();
      debouncedPersist.flush();
      store.dispatch({ kind: "set_session", session: null });
      store.dispatch({ kind: "set_view", view: "agents" });
    },
    closeSessions,
  });

  // ─── Public API for console input ──────────────────────────────────

  /** Handle text submitted from the console editor. */
  function handleConsoleInput(text: string): void {
    if (text.startsWith("/")) {
      handleSlashCommand(text);
      return;
    }
    sendChatMessage(text);
  }

  /** Handle palette command selection. */
  function handlePaletteSelect(commandId: string): void {
    handleCommand(commandId);
    hidePalette();
  }

  /** Handle agent selection from the list. */
  function handleAgentSelect(agentId: string): void {
    openAgentConsole(agentId);
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────
  async function start(): Promise<void> {
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
        const msgCount = await restoreSession(store, client, initialAgentId, initialSessionId);
        const countLabel = msgCount > 0 ? ` (${String(msgCount)} messages)` : "";
        addLifecycleMessage(`Resumed session ${initialSessionId}${countLabel}`);
        fetchRecentAgentActivity(client, store, initialAgentId).catch(() => {});
      } else {
        openAgentConsole(initialAgentId);
      }
    }

    // Periodic agent refresh as fallback (30s, SSE is primary)
    refreshTimer = setInterval(() => {
      refreshAgents().catch(() => {});
    }, refreshIntervalMs);

    // Start OpenTUI rendering — enters raw mode, takes over terminal
    await render(
      () =>
        TuiRoot({
          store,
          onConsoleInput: handleConsoleInput,
          onPaletteSelect: handlePaletteSelect,
          onAgentSelect: handleAgentSelect,
          onPaletteCancel: hidePalette,
          onKeyInput: keyboardHandler,
          syntaxStyle: syntaxStyle ?? undefined,
          onRendererReady: (r) => {
            tuiRenderer = r;
            syntaxStyle = SyntaxStyle.create();
          },
          sessions,
          sessionsLoading,
          onSessionSelect: handleSessionSelect,
          onSessionCancel: closeSessions,
        }),
      { exitOnCtrlC: false, useAlternateScreen: true, useMouse: true },
    );
  }

  async function stop(): Promise<void> {
    if (refreshTimer !== undefined) {
      clearInterval(refreshTimer);
      refreshTimer = undefined;
    }
    debouncedRefresh.cancel();
    debouncedPersist.flush();
    cancelActiveStream();
    await persistCurrentSession(store, client).catch(() => {});
    stopEventStream();
    if (syntaxStyle !== null) {
      syntaxStyle.destroy();
      syntaxStyle = null;
    }
    if (tuiRenderer !== null) {
      tuiRenderer.destroy();
      tuiRenderer = null;
    }
  }

  return {
    start,
    stop,
    store,
    handleConsoleInput,
    handlePaletteSelect,
    handleAgentSelect,
    handleKeyInput: keyboardHandler,
  };
}
