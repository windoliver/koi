/**
 * TUI application — wires views, store, clients, and OpenTUI together.
 *
 * Uses OpenTUI's CliRenderer with React reconciler for declarative UI.
 * Supports two modes: "welcome" (no admin API) and "boardroom" (connected).
 *
 * Command dispatch extracted to tui-commands.ts.
 * Data source operations extracted to tui-data-sources.ts.
 */

import {
  type AdminClient,
  type AguiStreamHandle,
  type ChatMessage,
  createAdminClient,
  createDebounce,
  createReconnectingStream,
  parseSessionRecord,
  type ReconnectHandle,
  startChatStream,
} from "@koi/dashboard-client";
import type {
  AgentDashboardEvent,
  DashboardEventBatch,
  DataSourceDashboardEvent,
} from "@koi/dashboard-types";
import {
  isAgentEvent,
  isDataSourceEvent,
  isLogEvent,
  isPtyOutputEvent,
} from "@koi/dashboard-types";
import type { OperationResult, PhaseCallbacks, SetupWizardState } from "@koi/setup-core";
import { KNOWN_CHANNELS, KNOWN_MODELS } from "@koi/setup-core";
import { type CliRenderer, createCliRenderer, SyntaxStyle } from "@opentui/core";
import { createRoot, type Root } from "@opentui/react";
import { createElement } from "react";
import { cycleLogLevel } from "../state/service-reducer.js";
import { createStore, type TuiStore } from "../state/store.js";
import {
  createInitialState,
  type SessionPickerEntry,
  type TuiMode,
  type TuiView,
} from "../state/types.js";
import { createAguiEventHandler } from "./agui-event-handler.js";
import { type CommandDeps, dispatchCommand, handleSlashCommand } from "./tui-commands.js";
import {
  approveDataSource,
  type DataSourceDeps,
  forwardConsentPrompts,
  openDataSources,
  rejectDataSource,
  rescanDataSources,
  viewDataSourceSchema,
} from "./tui-data-sources.js";
import { createKeyboardHandler } from "./tui-keyboard.js";
import { TuiRoot } from "./tui-root.js";
import { fetchRecentAgentActivity, persistCurrentSession, restoreSession } from "./tui-session.js";

/** Configuration for the TUI application. */
export interface TuiAppConfig {
  readonly adminUrl: string;
  readonly authToken?: string;
  /** App mode: "welcome" (no admin API) or "boardroom" (connected). */
  readonly mode?: TuiMode | undefined;
  /** Refresh interval for agent list in ms (default: 30000 — SSE is primary). */
  readonly refreshIntervalMs?: number;
  /** Auto-attach to this agent on launch. */
  readonly initialAgentId?: string;
  /** Resume a specific session (requires initialAgentId). */
  readonly initialSessionId?: string;
  /** Callback when a preset is selected in welcome mode. */
  readonly onPresetSelected?: ((presetId: string, agentName: string) => Promise<void>) | undefined;
  /** Scrollback lines for split-pane terminals (default: 500). */
  readonly splitPaneScrollback?: number | undefined;
  /** Presets to display in welcome mode. Passed in to avoid L2-to-L2 import. */
  readonly presets?: readonly import("../state/types.js").PresetInfo[] | undefined;
  /** In-process startup callback — replaces detached subprocess. */
  readonly onStartStack?:
    | ((state: SetupWizardState, callbacks: PhaseCallbacks) => Promise<OperationResult<void>>)
    | undefined;
  /** Override known models for the model step. */
  readonly models?: readonly string[] | undefined;
  /** Callback for service management commands from TUI. */
  readonly onServiceCommand?: ((command: string) => Promise<void>) | undefined;
}

/** Handle returned from createTuiApp for lifecycle management. */
export interface TuiAppHandle {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly store: TuiStore;
  readonly handleConsoleInput: (text: string) => void;
  readonly handlePaletteSelect: (commandId: string) => void;
  readonly handleAgentSelect: (agentId: string) => void;
  readonly handleKeyInput: (sequence: string) => boolean;
  /** Transition from welcome mode to boardroom mode. */
  readonly transitionToBoardroom: () => Promise<void>;
}

/**
 * Create and wire the complete TUI application.
 *
 * In "welcome" mode: renders preset picker, skips admin API connection.
 * In "boardroom" mode: full agent console with SSE streaming.
 */
export function createTuiApp(config: TuiAppConfig): TuiAppHandle {
  const {
    adminUrl,
    authToken,
    mode = "boardroom",
    refreshIntervalMs = 30_000,
    initialAgentId,
    initialSessionId,
    onPresetSelected,
    presets: configPresets,
    onStartStack,
    onServiceCommand,
  } = config;

  // ─── State ──────────────────────────────────────────────────────────
  const store = createStore(createInitialState(adminUrl, mode));

  // ─── Admin client ───────────────────────────────────────────────────
  const clientConfig =
    authToken !== undefined ? { baseUrl: adminUrl, authToken } : { baseUrl: adminUrl };
  const client: AdminClient = createAdminClient(clientConfig);

  // ─── Active stream handles ──────────────────────────────────────────
  let activeChatStream: AguiStreamHandle | null = null;
  let sseStream: ReconnectHandle | null = null;
  let tuiRenderer: CliRenderer | null = null;
  const syntaxStyle = SyntaxStyle.create();
  const aguiHandler = createAguiEventHandler(store);

  // ─── Debounced operations ───────────────────────────────────────────
  const debouncedRefresh = createDebounce(() => {
    refreshAgents().catch(() => {});
  }, 300);

  const debouncedPersist = createDebounce(() => {
    persistCurrentSession(store, client).catch(() => {});
  }, 500);

  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let reactRoot: Root | null = null;

  // ─── Shared helpers ─────────────────────────────────────────────────

  function addLifecycleMessage(event: string): void {
    store.dispatch({
      kind: "add_message",
      message: { kind: "lifecycle", event, timestamp: Date.now() },
    });
  }

  function cancelActiveStream(): void {
    if (activeChatStream !== null) {
      activeChatStream.cancel();
      activeChatStream = null;
      store.dispatch({ kind: "flush_tokens" });
      store.dispatch({ kind: "set_streaming", isStreaming: false });
    }
  }

  async function refreshAgents(): Promise<void> {
    const result = await client.listAgents();
    if (result.ok) {
      store.dispatch({ kind: "set_agents", agents: result.value });
    } else {
      store.dispatch({ kind: "set_error", error: result.error });
    }
  }

  // ─── Dependency bundles for extracted modules ───────────────────────

  const dsDeps: DataSourceDeps = { store, client, addLifecycleMessage };

  const cmdDeps: CommandDeps = {
    store,
    client,
    refreshAgents,
    openAgentConsole,
    openDataSources: () => openDataSources(dsDeps),
    rescanDataSources: () => rescanDataSources(dsDeps),
    approveDataSource: (name) => approveDataSource(name, dsDeps),
    viewDataSourceSchema: (name) => viewDataSourceSchema(name, dsDeps),
    openSessionPicker,
    showAgentLogs,
    openInBrowser,
    cancelActiveStream,
    stop,
    addLifecycleMessage,
    onServiceCommand,
  };

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
    const aguiConfig =
      authToken !== undefined
        ? { baseUrl: chatUrlObj.origin, path: chatUrlObj.pathname, authToken }
        : { baseUrl: chatUrlObj.origin, path: chatUrlObj.pathname };

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
              debouncedRefresh.call();
              forwardAgentEventsToConsole(typedBatch);
              checkConsentPrompts(typedBatch);
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

  // ─── Event forwarding ──────────────────────────────────────────────

  function forwardAgentEventsToConsole(batch: DashboardEventBatch): void {
    const session = store.getState().activeSession;
    for (const evt of batch.events) {
      if (isPtyOutputEvent(evt)) {
        store.dispatch({ kind: "append_pty_data", agentId: evt.agentId, data: evt.data });
        continue;
      }
      if (isLogEvent(evt)) {
        store.dispatch({
          kind: "append_log",
          entry: {
            level: evt.level,
            source: evt.source,
            message: evt.message,
            timestamp: evt.timestamp,
          },
        });
        continue;
      }
      if (isDataSourceEvent(evt)) {
        const desc = formatDataSourceEvent(evt);
        if (desc !== null) {
          addLifecycleMessage(desc);
          if (evt.subKind === "data_source_discovered") {
            openDataSources(dsDeps).catch(() => {});
          }
        }
        continue;
      }
      if (session === null) continue;
      if (!isAgentEvent(evt)) continue;
      if (evt.agentId !== session.agentId) continue;
      const desc = formatAgentEvent(evt);
      if (desc !== null) addLifecycleMessage(desc);
    }
  }

  function checkConsentPrompts(batch: DashboardEventBatch): void {
    let hasDiscovery = false;
    for (const evt of batch.events) {
      if (isDataSourceEvent(evt) && evt.subKind === "data_source_discovered") {
        hasDiscovery = true;
        break;
      }
    }
    forwardConsentPrompts(hasDiscovery, dsDeps);
  }

  // ─── Palette ───────────────────────────────────────────────────────

  function togglePalette(): void {
    if (store.getState().view === "palette") {
      hidePalette();
    } else if (store.getState().view !== "palette") {
      store.dispatch({ kind: "set_view", view: "palette" });
    }
  }

  function hidePalette(): void {
    if (store.getState().view !== "palette") return;
    const session = store.getState().activeSession;
    const targetView: TuiView = session !== null ? "console" : "agents";
    store.dispatch({ kind: "set_view", view: targetView });
  }

  // ─── Session picker (N+1 fix: parallel fetches) ───────────────────

  async function openSessionPicker(): Promise<void> {
    store.dispatch({ kind: "set_session_picker", entries: [], loading: true });
    store.dispatch({ kind: "set_view", view: "sessions" });

    const agents = store.getState().agents;

    // Parallel: fetch all agent session lists concurrently
    const listResults = await Promise.all(
      agents.map(async (agent) => {
        const result = await client.fsList(`/agents/${agent.agentId}/session/records`);
        return { agent, result };
      }),
    );

    // Parallel: fetch all session files concurrently
    const fileReads: Promise<SessionPickerEntry | null>[] = [];
    for (const { agent, result } of listResults) {
      if (!result.ok) continue;
      for (const file of result.value) {
        if (file.isDirectory || !file.name.endsWith(".json")) continue;
        fileReads.push(
          client.fsRead(file.path).then((readResult) => {
            if (!readResult.ok) return null;
            const content = typeof readResult.value === "string" ? readResult.value : "";
            const parsed = parseSessionRecord(content);
            if (parsed === null) return null;
            return {
              sessionId: parsed.sessionId,
              agentId: agent.agentId,
              agentName: parsed.agentName,
              connectedAt: parsed.connectedAt,
              messageCount: 0,
            };
          }),
        );
      }
    }

    const entries = (await Promise.all(fileReads)).filter(
      (e): e is SessionPickerEntry => e !== null,
    );
    entries.sort((a, b) => b.connectedAt - a.connectedAt);
    store.dispatch({ kind: "set_session_picker", entries, loading: false });
  }

  function handleSessionSelect(sessionId: string): void {
    const entry = store.getState().sessionPickerEntries.find((s) => s.sessionId === sessionId);
    if (entry === undefined) return;
    restoreSession(store, client, entry.agentId, sessionId)
      .then((count) =>
        addLifecycleMessage(`Restored session ${sessionId} (${String(count)} messages)`),
      )
      .catch(() => addLifecycleMessage(`Failed to restore session ${sessionId}`));
  }

  // ─── Consent ────────────────────────────────────────────────────────

  function consentApprove(): void {
    const pending = store.getState().pendingConsent;
    if (pending === undefined || pending.length === 0) return;
    const first = pending[0];
    if (first === undefined) return;
    approveDataSource(first.name, dsDeps).catch(() => {});
    store.dispatch({ kind: "clear_pending_consent" });
    store.dispatch({ kind: "set_view", view: "agents" });
  }

  function consentDeny(): void {
    const pending = store.getState().pendingConsent;
    if (pending !== undefined) {
      for (const s of pending) {
        rejectDataSource(s.name, dsDeps).catch(() => {});
      }
    }
    store.dispatch({ kind: "clear_pending_consent" });
    store.dispatch({ kind: "set_view", view: "agents" });
    addLifecycleMessage("Data source denied");
  }

  function consentDetails(): void {
    const pending = store.getState().pendingConsent;
    if (pending === undefined || pending.length === 0) return;
    const first = pending[0];
    if (first === undefined) return;
    viewDataSourceSchema(first.name, dsDeps).catch(() => {});
  }

  function closeConsent(): void {
    store.dispatch({ kind: "clear_pending_consent" });
    const session = store.getState().activeSession;
    store.dispatch({ kind: "set_view", view: session !== null ? "console" : "agents" });
  }

  // ─── Agent logs ──────────────────────────────────────────────────

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

  // ─── Keyboard handler ─────────────────────────────────────────────

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
    closeSessions: () => {
      store.dispatch({ kind: "set_view", view: "agents" });
    },
    closeDataSources: () => {
      const currentView = store.getState().view;
      if (currentView === "sourcedetail") {
        store.dispatch({ kind: "set_view", view: "datasources" });
      } else if (store.getState().selectedPresetId !== null) {
        // In wizard flow: datasources back → channels
        store.dispatch({ kind: "set_view", view: "channels" });
      } else {
        store.dispatch({ kind: "set_view", view: "agents" });
      }
    },
    dataSourceUp: () => {
      store.dispatch({
        kind: "select_data_source",
        index: store.getState().selectedDataSourceIndex - 1,
      });
    },
    dataSourceDown: () => {
      store.dispatch({
        kind: "select_data_source",
        index: store.getState().selectedDataSourceIndex + 1,
      });
    },
    dataSourceApprove: () => {
      const source = store.getState().dataSources[store.getState().selectedDataSourceIndex];
      if (source !== undefined) approveDataSource(source.name, dsDeps).catch(() => {});
    },
    dataSourceSchema: () => {
      const source = store.getState().dataSources[store.getState().selectedDataSourceIndex];
      if (source !== undefined) viewDataSourceSchema(source.name, dsDeps).catch(() => {});
    },
    dataSourcesContinue: () => {
      // In wizard flow: datasources → addons
      if (store.getState().selectedPresetId !== null) {
        store.dispatch({ kind: "set_view", view: "addons" });
      }
    },
    consentApprove,
    consentDeny,
    consentDetails,
    closeConsent,
    toggleForge: () => {
      const currentView = store.getState().view;
      store.dispatch({ kind: "set_view", view: currentView === "forge" ? "agents" : "forge" });
    },
    presetSelect: () => {
      const presets = store.getState().presets;
      const idx = store.getState().selectedPresetIndex;
      const preset = presets[idx];
      if (preset !== undefined) {
        // In preset detail view, select the active detail preset
        const activeDetail = store.getState().activePresetDetail;
        const targetPreset =
          store.getState().view === "presetdetail" && activeDetail !== null ? activeDetail : preset;
        handlePresetSelect(targetPreset.id);
      }
    },
    presetDetails: () => {
      const presets = store.getState().presets;
      const idx = store.getState().selectedPresetIndex;
      const preset = presets[idx];
      if (preset !== undefined) {
        handlePresetDetails(preset.id);
      }
    },
    presetBack: () => {
      store.dispatch({ kind: "set_active_preset_detail", detail: null });
      store.dispatch({ kind: "set_view", view: "welcome" });
    },
    toggleSplitPanes: () => {
      const currentView = store.getState().view;
      store.dispatch({
        kind: "set_view",
        view: currentView === "splitpanes" ? "agents" : "splitpanes",
      });
    },
    nameConfirm: () => {
      handleNameConfirm();
    },
    nameBack: () => {
      store.dispatch({ kind: "set_view", view: "welcome" });
    },
    addonsConfirm: () => {
      handleAddonsConfirm();
    },
    addonsSkip: () => {
      handleAddonsSkip();
    },
    addonsToggle: () => {
      const ADDON_IDS = ["telegram", "slack", "discord", "temporal", "mcp", "browser", "voice"];
      const focusedIdx = store.getState().addonFocusedIndex;
      const addonId = ADDON_IDS[focusedIdx % ADDON_IDS.length];
      if (addonId !== undefined) {
        store.dispatch({ kind: "toggle_addon", addonId });
      }
    },
    addonsBack: () => {
      const presetId = store.getState().selectedPresetId;
      store.dispatch({ kind: "set_view", view: presetId === "local" ? "datasources" : "channels" });
    },
    modelSelect: () => {
      const models = config.models ?? [...KNOWN_MODELS];
      const idx = store.getState().modelFocusedIndex;
      const model = models[idx];
      if (model !== undefined) {
        store.dispatch({ kind: "set_selected_model", model });
      }
      store.dispatch({ kind: "set_view", view: "engine" });
    },
    modelBack: () => {
      store.dispatch({ kind: "set_view", view: "nameinput" });
    },
    engineConfirm: () => {
      store.dispatch({ kind: "set_view", view: "channels" });
    },
    engineSkip: () => {
      store.dispatch({ kind: "set_selected_engine", engine: undefined });
      store.dispatch({ kind: "set_view", view: "channels" });
    },
    engineBack: () => {
      store.dispatch({ kind: "set_view", view: "model" });
    },
    channelsConfirm: () => {
      // For local preset, show data source discovery step; demo/mesh get sources from Nexus
      const presetId = store.getState().selectedPresetId;
      if (presetId === "local") {
        store.dispatch({ kind: "set_view", view: "datasources" });
      } else {
        store.dispatch({ kind: "set_view", view: "addons" });
      }
    },
    channelsToggle: () => {
      const idx = store.getState().channelFocusedIndex;
      const channel = KNOWN_CHANNELS[idx];
      if (channel !== undefined) {
        store.dispatch({ kind: "toggle_channel", channel });
      }
    },
    channelsBack: () => {
      store.dispatch({ kind: "set_view", view: "engine" });
    },
    serviceStop: () => {
      onServiceCommand?.("stop").catch(() => {});
    },
    serviceDoctor: () => {
      onServiceCommand?.("doctor").catch(() => {});
    },
    serviceLogs: () => {
      store.dispatch({ kind: "set_view", view: "logs" });
    },
    serviceBack: () => {
      store.dispatch({ kind: "set_view", view: "agents" });
    },
    logsCycleLevel: () => {
      const current = store.getState().logLevel;
      store.dispatch({ kind: "set_log_level", level: cycleLogLevel(current) });
    },
    logsBack: () => {
      store.dispatch({ kind: "set_view", view: "service" });
    },
  });

  // ─── Public API ───────────────────────────────────────────────────

  function handleConsoleInput(text: string): void {
    if (text.startsWith("/")) {
      handleSlashCommand(text, cmdDeps);
      return;
    }
    sendChatMessage(text);
  }

  function handlePaletteSelect(commandId: string): void {
    hidePalette();
    dispatchCommand(commandId, cmdDeps);
  }

  function handleAgentSelect(agentId: string): void {
    openAgentConsole(agentId);
  }

  // ─── Welcome mode handlers ────────────────────────────────────────

  function handlePresetSelect(presetId: string): void {
    // Don't call onPresetSelected yet — go to name input first
    store.dispatch({ kind: "set_selected_preset_id", presetId });
    store.dispatch({ kind: "set_agent_name_input", name: `koi-${presetId}` });
    store.dispatch({ kind: "set_view", view: "nameinput" });
  }

  function handleNameConfirm(): void {
    // After name input, go to model selection
    // Full wizard flow: preset → name → model → engine → channels → dataSources → addons
    store.dispatch({ kind: "set_view", view: "model" });
  }

  function handleAddonsConfirm(): void {
    const presetId = store.getState().selectedPresetId;
    const agentName = store.getState().agentNameInput;
    const state = store.getState();

    if (presetId !== null && onStartStack !== undefined) {
      // Build SetupWizardState from TUI state, including discovered data sources
      const approvedSources = state.dataSources
        .filter((s) => s.status === "approved")
        .map((s) => ({ name: s.name, protocol: s.protocol }));
      const wizardState: SetupWizardState = {
        preset: presetId,
        name: agentName,
        description: "A Koi agent",
        model: state.selectedModel,
        engine: state.selectedEngine,
        channels: [...state.selectedChannels],
        addons: [...state.selectedAddons],
        dataSources: approvedSources,
        demoPack: presetId === "demo" ? "connected" : undefined,
      };

      store.dispatch({ kind: "set_view", view: "progress" });
      store.dispatch({ kind: "set_setup_running", running: true });

      const callbacks: PhaseCallbacks = {
        onPhaseStart: (phaseId, label) => {
          store.dispatch({
            kind: "append_phase_progress",
            progress: { phaseId, label, status: "running" },
          });
        },
        onPhaseProgress: (phaseId, message) => {
          // Update the last progress entry with the message
          const phases = store.getState().phaseProgress;
          const updated = phases.map((p) => (p.phaseId === phaseId ? { ...p, message } : p));
          // Re-set via clear + re-append to avoid mutation
          store.dispatch({ kind: "clear_phase_progress" });
          store.dispatch({ kind: "set_setup_running", running: true });
          for (const p of updated) {
            store.dispatch({ kind: "append_phase_progress", progress: p });
          }
        },
        onPhaseDone: (phaseId) => {
          const phases = store.getState().phaseProgress;
          const updated = phases.map((p) =>
            p.phaseId === phaseId ? { ...p, status: "done" as const } : p,
          );
          store.dispatch({ kind: "clear_phase_progress" });
          store.dispatch({ kind: "set_setup_running", running: true });
          for (const p of updated) {
            store.dispatch({ kind: "append_phase_progress", progress: p });
          }
        },
        onPhaseFailed: (phaseId, error) => {
          const phases = store.getState().phaseProgress;
          const updated = phases.map((p) =>
            p.phaseId === phaseId ? { ...p, status: "failed" as const, error } : p,
          );
          store.dispatch({ kind: "clear_phase_progress" });
          for (const p of updated) {
            store.dispatch({ kind: "append_phase_progress", progress: p });
          }
          store.dispatch({ kind: "set_setup_running", running: false });
        },
      };

      onStartStack(wizardState, callbacks)
        .then((result) => {
          store.dispatch({ kind: "set_setup_running", running: false });
          if (result.ok) {
            transitionToBoardroom().catch(() => {});
          } else {
            // Surface the error as a failed phase in the progress view
            store.dispatch({
              kind: "append_phase_progress",
              progress: {
                phaseId: result.error.phase ?? "unknown",
                label: result.error.phase ?? "Setup",
                status: "failed",
                error: result.error.message,
              },
            });
          }
        })
        .catch((err: unknown) => {
          // Unexpected error (scaffold failure, import failure, etc.)
          store.dispatch({ kind: "set_setup_running", running: false });
          const message = err instanceof Error ? err.message : String(err);
          store.dispatch({
            kind: "append_phase_progress",
            progress: {
              phaseId: "setup",
              label: "Setup",
              status: "failed",
              error: message,
            },
          });
        });
      return;
    }

    if (presetId !== null && onPresetSelected !== undefined) {
      onPresetSelected(presetId, agentName).catch(() => {});
    }
  }

  function handleAddonsSkip(): void {
    handleAddonsConfirm();
  }

  function handlePresetDetails(presetId: string): void {
    const preset = store.getState().presets.find((p) => p.id === presetId);
    if (preset !== undefined) {
      store.dispatch({ kind: "set_active_preset_detail", detail: preset });
      store.dispatch({ kind: "set_view", view: "presetdetail" });
    }
  }

  // ─── Lifecycle ────────────────────────────────────────────────────

  async function start(): Promise<void> {
    // Start OpenTUI rendering first (enters raw mode, takes over terminal)
    tuiRenderer = await createCliRenderer({
      exitOnCtrlC: false,
      useAlternateScreen: true,
      useMouse: true,
    });
    reactRoot = createRoot(tuiRenderer);

    if (mode === "welcome") {
      if (configPresets !== undefined && configPresets.length > 0) {
        store.dispatch({ kind: "set_presets", presets: configPresets });
      }
      renderTui();
      return;
    }

    // Boardroom mode: connect to admin API
    store.dispatch({ kind: "set_connection_status", status: "reconnecting" });
    const healthResult = await client.checkHealth();
    if (healthResult.ok) {
      store.dispatch({ kind: "set_connection_status", status: "connected" });
    } else {
      store.dispatch({ kind: "set_connection_status", status: "disconnected" });
      store.dispatch({ kind: "set_error", error: healthResult.error });
    }

    await refreshAgents();
    startEventStream();

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

    refreshTimer = setInterval(() => {
      refreshAgents().catch(() => {});
    }, refreshIntervalMs);
    renderTui();
  }

  /** Transition from welcome mode to boardroom (after init + up). */
  async function transitionToBoardroom(): Promise<void> {
    store.dispatch({ kind: "set_view", view: "agents" });
    store.dispatch({ kind: "set_connection_status", status: "reconnecting" });

    const healthResult = await client.checkHealth();
    if (healthResult.ok) {
      store.dispatch({ kind: "set_connection_status", status: "connected" });
    } else {
      store.dispatch({ kind: "set_connection_status", status: "disconnected" });
      store.dispatch({ kind: "set_error", error: healthResult.error });
    }

    await refreshAgents();
    startEventStream();
    refreshTimer = setInterval(() => {
      refreshAgents().catch(() => {});
    }, refreshIntervalMs);
  }

  function renderTui(): void {
    if (reactRoot === null) return;
    reactRoot.render(
      createElement(TuiRoot, {
        store,
        onConsoleInput: handleConsoleInput,
        onPaletteSelect: handlePaletteSelect,
        onAgentSelect: handleAgentSelect,
        onPaletteCancel: hidePalette,
        onKeyInput: keyboardHandler,
        syntaxStyle,
        onSessionSelect: handleSessionSelect,
        onSessionCancel: () => {
          store.dispatch({ kind: "set_view", view: "agents" });
        },
        onDataSourceApprove: (name: string) => {
          approveDataSource(name, dsDeps).catch(() => {});
        },
        onDataSourceViewSchema: (name: string) => {
          viewDataSourceSchema(name, dsDeps).catch(() => {});
        },
        onConsentApprove: (name: string) => {
          approveDataSource(name, dsDeps).catch(() => {});
          store.dispatch({ kind: "clear_pending_consent" });
          store.dispatch({ kind: "set_view", view: "agents" });
        },
        onConsentDeny: () => {
          consentDeny();
        },
        onConsentDetails: (name: string) => {
          viewDataSourceSchema(name, dsDeps).catch(() => {});
        },
        onConsentDismiss: () => {
          closeConsent();
        },
        onPresetSelect: handlePresetSelect,
        onPresetDetails: handlePresetDetails,
        onPresetBack: () => {
          store.dispatch({ kind: "set_active_preset_detail", detail: null });
          store.dispatch({ kind: "set_view", view: "welcome" });
        },
      }),
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
    if (reactRoot !== null) {
      reactRoot.unmount();
      reactRoot = null;
    }
    syntaxStyle.destroy();
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
    transitionToBoardroom,
  };
}

// ─── Event formatters ──────────────────────────────────────────────────

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

function formatDataSourceEvent(evt: DataSourceDashboardEvent): string | null {
  switch (evt.subKind) {
    case "data_source_discovered":
      return `Data source discovered: ${evt.name} (${evt.protocol}) from ${evt.source}`;
    case "connector_forged":
      return `Connector forged for: ${evt.name} (${evt.protocol})`;
    case "connector_health_update":
      return `Connector ${evt.name}: ${evt.healthy ? "healthy" : "unhealthy"}`;
    default:
      return null;
  }
}
