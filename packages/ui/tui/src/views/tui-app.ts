/** TUI application — wires views, store, clients, and OpenTUI together. */

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
  createNewViewCallbacks,
  type DomainActionDeps,
  type EventStreamHandle,
  fetchDataForView as fetchDataForViewFn,
  forwardAgentEventsToConsole as forwardAgentEventsHelper,
  getDomainScrollOffset,
  governanceApprove as govApproveFn,
  governanceDeny as govDenyFn,
  harnessPauseResume as harnessPrFn,
  schedulerRetryDlq as schedRetryFn,
  temporalDetail as tempDetailFn,
  temporalSignal as tempSignalFn,
  temporalTerminate as tempTermFn,
  viewToDomainKey,
} from "./tui-event-stream.js";
import { createKeyboardHandler } from "./tui-keyboard.js";
import { TuiRoot } from "./tui-root.js";
import { fetchRecentAgentActivity, persistCurrentSession, restoreSession } from "./tui-session.js";

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

export interface TuiAppHandle {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly store: TuiStore;
  readonly handleConsoleInput: (text: string) => void;
  readonly handlePaletteSelect: (commandId: string) => void;
  readonly handleAgentSelect: (agentId: string) => void;
  readonly handleKeyInput: (sequence: string) => boolean;
  readonly transitionToBoardroom: () => Promise<void>;
}
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

  const store = createStore(createInitialState(adminUrl, mode));

  const clientConfig =
    authToken !== undefined ? { baseUrl: adminUrl, authToken } : { baseUrl: adminUrl };
  const client: AdminClient = createAdminClient(clientConfig);

  let activeChatStream: AguiStreamHandle | null = null;
  let tuiRenderer: CliRenderer | null = null;
  const syntaxStyle = SyntaxStyle.create();
  const aguiHandler = createAguiEventHandler(store);

  const debouncedRefresh = createDebounce(() => {
    refreshAgents().catch(() => {});
  }, 300);

  const debouncedPersist = createDebounce(() => {
    persistCurrentSession(store, client).catch(() => {});
  }, 500);

  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let reactRoot: Root | null = null;
  let lastView: import("../state/types.js").TuiView = mode === "welcome" ? "welcome" : "agents";

  const fetchDeps = { store, client };
  store.subscribe((s) => {
    if (s.view === lastView) return;
    lastView = s.view;
    fetchDataForViewFn(s.view, fetchDeps);
  });

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

  const eventStream: EventStreamHandle = createEventStream({
    store,
    eventsUrl: client.eventsUrl(),
    ...(authToken !== undefined ? { authToken } : {}),
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

  const domainDeps: DomainActionDeps = { store, client, addLifecycleMessage };
  const nvCb = createNewViewCallbacks(domainDeps);

  function scrollDomain(d: number): void {
    const dk = viewToDomainKey(store.getState().view);
    if (dk !== null)
      store.dispatch({
        kind: "scroll_domain_view",
        domain: dk,
        offset: getDomainScrollOffset(store.getState(), dk) + d,
      });
  }

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
      store.dispatch({
        kind: "set_view",
        view: store.getState().view === "sourcedetail" ? "datasources" : "agents",
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
      store.dispatch({
        kind: "set_view",
        view: store.getState().view === "forge" ? "agents" : "forge",
      });
    },
    toggleCost: () => {
      store.dispatch({
        kind: "set_view",
        view: store.getState().view === "cost" ? "agents" : "cost",
      });
    },
    toggleNexus: () => {
      store.dispatch({
        kind: "set_view",
        view: store.getState().view === "files" ? "agents" : "files",
      });
    },
    navigateBack: () => {
      // Finding 2 fix: from temporal detail, go back to list (not exit view)
      if (
        store.getState().view === "temporal" &&
        store.getState().temporalView.workflowDetail !== null
      ) {
        store.dispatch({ kind: "set_temporal_workflow_detail", detail: null });
        return;
      }
      const session = store.getState().activeSession;
      store.dispatch({ kind: "set_view", view: session !== null ? "console" : "agents" });
    },
    domainScrollUp: () => {
      scrollDomain(-1);
    },
    domainScrollDown: () => {
      scrollDomain(1);
    },
    temporalSelectNext: () => {
      store.dispatch({
        kind: "select_temporal_workflow",
        index: store.getState().temporalView.selectedWorkflowIndex + 1,
      });
    },
    temporalSelectPrev: () => {
      store.dispatch({
        kind: "select_temporal_workflow",
        index: store.getState().temporalView.selectedWorkflowIndex - 1,
      });
    },
    temporalDetail: () => {
      tempDetailFn(domainDeps);
    },
    temporalSignal: () => {
      tempSignalFn(domainDeps);
    },
    temporalTerminate: () => {
      tempTermFn(domainDeps);
    },
    schedulerRetryDlq: () => {
      schedRetryFn(domainDeps);
    },
    harnessPauseResume: () => {
      harnessPrFn(domainDeps);
    },
    governanceSelectNext: () => {
      store.dispatch({
        kind: "select_governance_item",
        index: store.getState().governanceView.selectedIndex + 1,
      });
    },
    governanceSelectPrev: () => {
      store.dispatch({
        kind: "select_governance_item",
        index: store.getState().governanceView.selectedIndex - 1,
      });
    },
    governanceApprove: () => {
      govApproveFn(domainDeps);
    },
    governanceDeny: () => {
      govDenyFn(domainDeps);
    },
    ...nvCb,
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
      store.dispatch({
        kind: "set_view",
        view: store.getState().view === "splitpanes" ? "agents" : "splitpanes",
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
      const addonId = ADDON_IDS[store.getState().addonFocusedIndex % ADDON_IDS.length];
      if (addonId !== undefined) store.dispatch({ kind: "toggle_addon", addonId });
    },
    addonsBack: () => {
      store.dispatch({ kind: "set_view", view: "nameinput" });
    },
  });

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
