/**
 * TUI application — wires views, store, clients, and OpenTUI together.
 * Modules: tui-commands.ts, tui-data-sources.ts, tui-event-stream.ts, tui-consent.ts.
 */

import {
  type AdminClient,
  type AguiStreamHandle,
  type ChatMessage,
  createAdminClient,
  createDebounce,
  createReconnectingStream,
  parseSessionRecord,
  startChatStream,
} from "@koi/dashboard-client";
import type { DashboardEventBatch } from "@koi/dashboard-types";
import { type CliRenderer, createCliRenderer, SyntaxStyle } from "@opentui/core";
import { createRoot, type Root } from "@opentui/react";
import { createElement } from "react";
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
  type ConsentDeps,
  closeConsent as closeConsentHelper,
  consentApprove as consentApproveHelper,
  consentDeny as consentDenyHelper,
  consentDetails as consentDetailsHelper,
} from "./tui-consent.js";
import {
  approveDataSource,
  type DataSourceDeps,
  forwardConsentPrompts,
  openDataSources,
  rescanDataSources,
  viewDataSourceSchema,
} from "./tui-data-sources.js";
import {
  checkConsentPrompts as checkConsentPromptsHelper,
  createEventStream,
  type EventStreamHandle,
  fetchDataForView as fetchDataForViewFn,
  forwardAgentEventsToConsole as forwardAgentEventsHelper,
  getDomainScrollOffset,
  viewToDomainKey,
} from "./tui-event-stream.js";
import { createKeyboardHandler } from "./tui-keyboard.js";
import { TuiRoot } from "./tui-root.js";
import { fetchRecentAgentActivity, persistCurrentSession, restoreSession } from "./tui-session.js";

/** Configuration for the TUI application. */
export interface TuiAppConfig {
  readonly adminUrl: string;
  readonly authToken?: string;
  readonly mode?: TuiMode | undefined;
  readonly refreshIntervalMs?: number;
  readonly initialAgentId?: string;
  readonly initialSessionId?: string;
  readonly onPresetSelected?: ((presetId: string, agentName: string) => Promise<void>) | undefined;
  readonly splitPaneScrollback?: number | undefined;
  readonly presets?: readonly import("../state/types.js").PresetInfo[] | undefined;
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
  } = config;

  // ─── State ──────────────────────────────────────────────────────────
  const store = createStore(createInitialState(adminUrl, mode));

  // ─── Admin client ───────────────────────────────────────────────────
  const clientConfig =
    authToken !== undefined ? { baseUrl: adminUrl, authToken } : { baseUrl: adminUrl };
  const client: AdminClient = createAdminClient(clientConfig);

  // ─── Active stream handles ──────────────────────────────────────────
  let activeChatStream: AguiStreamHandle | null = null;
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
  let lastView: import("../state/types.js").TuiView = mode === "welcome" ? "welcome" : "agents";

  // ─── View-open data fetching ──────────────────────────────────────
  const fetchDeps = { store, client };
  store.subscribe((s) => {
    if (s.view === lastView) return;
    lastView = s.view;
    fetchDataForViewFn(s.view, fetchDeps);
  });

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

  const eventStream: EventStreamHandle = createEventStream({
    store,
    eventsUrl: client.eventsUrl(),
    authToken,
    createReconnectingStream,
    onBatch: (typedBatch) => {
      store.dispatch({ kind: "apply_event_batch", batch: typedBatch });
      debouncedRefresh.call();
      forwardAgentEventsToConsole(typedBatch);
      checkConsentPrompts(typedBatch);
    },
  });

  function startEventStream(): void {
    eventStream.start();
  }
  function stopEventStream(): void {
    eventStream.stop();
  }

  // ─── Event forwarding ──────────────────────────────────────────────

  const eventForwardDeps = {
    store,
    addLifecycleMessage,
    openDataSources: () => openDataSources(dsDeps),
    forwardConsentPrompts: (hasDiscovery: boolean) => forwardConsentPrompts(hasDiscovery, dsDeps),
  };

  function forwardAgentEventsToConsole(batch: DashboardEventBatch): void {
    forwardAgentEventsHelper(batch, eventForwardDeps);
  }

  function checkConsentPrompts(batch: DashboardEventBatch): void {
    checkConsentPromptsHelper(batch, eventForwardDeps);
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

  const cDeps: ConsentDeps = { store, dsDeps, addLifecycleMessage };
  function consentApprove(): void {
    consentApproveHelper(cDeps);
  }
  function consentDeny(): void {
    consentDenyHelper(cDeps);
  }
  function consentDetails(): void {
    consentDetailsHelper(cDeps);
  }
  function closeConsent(): void {
    closeConsentHelper(cDeps);
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

  function scrollDomain(d: number): void {
    const dk = viewToDomainKey(store.getState().view);
    if (dk !== null)
      store.dispatch({
        kind: "scroll_domain_view",
        domain: dk,
        offset: getDomainScrollOffset(store.getState(), dk) + d,
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
      store.dispatch({
        kind: "set_view",
        view: currentView === "sourcedetail" ? "datasources" : "agents",
      });
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
    consentApprove,
    consentDeny,
    consentDetails,
    closeConsent,
    toggleForge: () => {
      const currentView = store.getState().view;
      store.dispatch({ kind: "set_view", view: currentView === "forge" ? "agents" : "forge" });
    },
    toggleCost: () => {
      const currentView = store.getState().view;
      store.dispatch({ kind: "set_view", view: currentView === "cost" ? "agents" : "cost" });
    },
    toggleNexus: () => {
      const currentView = store.getState().view;
      store.dispatch({ kind: "set_view", view: currentView === "nexus" ? "agents" : "nexus" });
    },
    closeDomainView: () => {
      store.dispatch({ kind: "set_view", view: "agents" });
    },
    domainScrollUp: () => {
      scrollDomain(-1);
    },
    domainScrollDown: () => {
      scrollDomain(1);
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
      store.dispatch({ kind: "set_view", view: "nameinput" });
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
    // After name input, go to add-on picker
    store.dispatch({ kind: "set_view", view: "addons" });
  }

  function handleAddonsConfirm(): void {
    const presetId = store.getState().selectedPresetId;
    const agentName = store.getState().agentNameInput;
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
      if (healthResult.value.capabilities !== undefined) {
        store.dispatch({ kind: "set_capabilities", capabilities: healthResult.value.capabilities });
      }
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
      if (healthResult.value.capabilities !== undefined) {
        store.dispatch({ kind: "set_capabilities", capabilities: healthResult.value.capabilities });
      }
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
