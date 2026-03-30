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
  /** In-process startup callback — replaces detached subprocess. */
  readonly onStartStack?:
    | ((state: SetupWizardState, callbacks: PhaseCallbacks) => Promise<OperationResult<void>>)
    | undefined;
  /** Override known models for the model step. */
  readonly models?: readonly string[] | undefined;
  /** Callback for service management commands from TUI. */
  readonly onServiceCommand?: ((command: string) => Promise<void>) | undefined;
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
    onStartStack,
    onServiceCommand,
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
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;

  /** Throttled resize handler — fires at most once per 100ms. */
  function handleResize(): void {
    if (resizeTimer !== undefined) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = undefined;
      store.dispatch({ kind: "set_terminal_cols", cols: process.stdout.columns ?? 120 });
    }, 100);
  }
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

  /** Fetch forge bricks + events from REST API to hydrate initial state. */
  async function refreshForge(): Promise<void> {
    const [bricksResult, eventsResult] = await Promise.all([
      client.listForgeBricks(),
      client.listForgeEvents(),
    ]);
    const bricks = bricksResult.ok ? bricksResult.value : [];
    const events = eventsResult.ok ? eventsResult.value : [];
    // Always dispatch — even empty results should clear stale state from a previous session.
    store.dispatch({ kind: "hydrate_forge", bricks, events });
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
    onServiceCommand,
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

    // Write session record at namespace root so it persists across koi-up restarts.
    // Each koi-up gets a new agentId (cli:koi-demo:{timestamp}), so per-agentId paths
    // would be invisible to future sessions.
    const record = JSON.stringify({
      sessionId,
      agentId,
      agentName: agent?.name ?? agentId,
      connectedAt: Date.now(),
    });
    client.fsWrite(`/session/records/${sessionId}.json`, record).catch(() => {});
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
    const aguiConfig =
      authToken !== undefined
        ? { baseUrl: chatUrl, path: "", authToken }
        : { baseUrl: chatUrl, path: "" };

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
          const detail = "message" in error ? ` — ${error.message}` : "";
          store.dispatch({
            kind: "add_message",
            message: {
              kind: "lifecycle",
              event: `Stream error: ${error.kind}${detail}`,
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

  /** View that was active before the palette opened, so we can return to it. */
  let viewBeforePalette: TuiView = "agents";

  function togglePalette(): void {
    if (store.getState().view === "palette") {
      hidePalette();
    } else if (store.getState().view !== "palette") {
      viewBeforePalette = store.getState().view;
      store.dispatch({ kind: "set_view", view: "palette" });
    }
  }

  function hidePalette(): void {
    if (store.getState().view !== "palette") return;
    store.dispatch({ kind: "set_view", view: viewBeforePalette });
  }

  async function openSessionPicker(): Promise<void> {
    store.dispatch({ kind: "set_session_picker", entries: [], loading: true });
    store.dispatch({ kind: "set_view", view: "sessions" });

    const agents = store.getState().agents;

    const extractContent = (raw: unknown): string => {
      if (typeof raw === "string") return raw;
      if (typeof raw === "object" && raw !== null && "content" in raw) {
        return String((raw as Record<string, unknown>).content);
      }
      return "";
    };

    // Fetch sessions from namespace-root /session/records/ (shared across koi-up restarts)
    // plus per-agent paths for backward compatibility
    const rootResult = await client.fsList("/session/records");
    const listResults = [
      ...(rootResult.ok ? [{ agent: agents[0], result: rootResult }] : []),
      ...(await Promise.all(
        agents.map(async (agent) => {
          const result = await client.fsList(`/agents/${agent.agentId}/session/records`);
          return { agent, result };
        }),
      )),
    ];

    // Parallel: fetch all session record files concurrently
    const fileReads: Promise<SessionPickerEntry | null>[] = [];
    for (const { agent, result } of listResults) {
      if (!result.ok) continue;
      for (const file of result.value) {
        if (file.isDirectory || !file.name.endsWith(".json")) continue;
        fileReads.push(
          client.fsRead(file.path).then(async (readResult) => {
            if (!readResult.ok) return null;
            const content = extractContent(readResult.value as unknown);
            const parsed = parseSessionRecord(content);
            if (parsed === null) return null;

            const entryAgentId = parsed.agentId ?? agent?.agentId ?? "";

            // Read session log to get actual message count and preview.
            // Try logPath from record first (human-readable name), then fallback paths.
            const logPaths = [
              ...(parsed.logPath !== undefined ? [parsed.logPath] : []),
              `/session/chat/${parsed.sessionId}.jsonl`,
              `/agents/${entryAgentId}/session/chat/${parsed.sessionId}.jsonl`,
              `/session/tui/${parsed.sessionId}.jsonl`,
            ];
            let logContent = "";
            for (const lp of logPaths) {
              const logResult = await client.fsRead(lp);
              if (logResult.ok) {
                logContent = extractContent(logResult.value as unknown);
                break;
              }
            }
            const lines = logContent.split("\n").filter((l) => l.trim() !== "");

            // Count only user + assistant messages (not lifecycle noise)
            let chatCount = 0;
            let preview = "";
            for (const line of lines) {
              try {
                const msg = JSON.parse(line) as { readonly kind?: string; readonly text?: string };
                if (msg.kind === "user" || msg.kind === "assistant") {
                  chatCount++;
                  if (preview === "" && msg.kind === "user" && typeof msg.text === "string") {
                    preview = msg.text.length > 60 ? `${msg.text.slice(0, 57)}...` : msg.text;
                  }
                }
              } catch {
                // skip malformed lines
              }
            }

            return {
              sessionId: parsed.sessionId,
              agentId: entryAgentId,
              agentName: parsed.agentName,
              connectedAt: parsed.connectedAt,
              messageCount: chatCount,
              preview,
              logPath: parsed.logPath,
            };
          }),
        );
      }
    }

    const allEntries = (await Promise.all(fileReads)).filter(
      (e): e is SessionPickerEntry => e !== null,
    );

    // Dedup by sessionId (same session may appear at both namespace-root and per-agent paths)
    const seen = new Set<string>();
    const entries: SessionPickerEntry[] = [];
    for (const entry of allEntries) {
      if (!seen.has(entry.sessionId)) {
        seen.add(entry.sessionId);
        entries.push(entry);
      }
    }

    entries.sort((a, b) => b.connectedAt - a.connectedAt);
    store.dispatch({ kind: "set_session_picker", entries, loading: false });
  }

  function handleSessionSelect(sessionId: string): void {
    const entry = store.getState().sessionPickerEntries.find((s) => s.sessionId === sessionId);
    if (entry === undefined) return;

    // Use saved agentId for loading (data lives at old per-agent path),
    // then update session to current agent so chat/persist use the live agent.
    const currentAgent = store.getState().agents[0];
    const currentAgentId = currentAgent?.agentId ?? entry.agentId;

    restoreSession(store, client, entry.agentId, sessionId, entry.logPath)
      .then(() => {
        // Rewrite session agentId to current agent so sendChatMessage targets the live agent
        const session = store.getState().activeSession;
        if (session !== null && session.agentId !== currentAgentId) {
          store.dispatch({
            kind: "set_session",
            session: { ...session, agentId: currentAgentId },
          });
        }
      })
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
      const currentView = store.getState().view;
      if (currentView === "sourcedetail") {
        store.dispatch({ kind: "set_view", view: "datasources" });
      } else if (store.getState().selectedPresetId !== null) {
        // In wizard flow: datasources back → channel picker
        store.dispatch({ kind: "set_view", view: "channelspicker" });
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
      // Intra-view detail: clear detail state without leaving the view
      if (
        store.getState().view === "temporal" &&
        store.getState().temporalView.workflowDetail !== null
      ) {
        store.dispatch({ kind: "set_temporal_workflow_detail", detail: null });
        return;
      }
      // Pop navigation stack (falls back to "agents" when empty)
      store.dispatch({ kind: "navigate_back" });
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
      store.dispatch({ kind: "set_view", view: "nexusconfig" });
    },
    addonsSkip: () => {
      store.dispatch({ kind: "set_view", view: "nexusconfig" });
    },
    addonsToggle: () => {
      const ADDON_IDS = ["telegram", "slack", "discord", "temporal", "mcp", "browser", "voice"];
      const addonId = ADDON_IDS[store.getState().addonFocusedIndex % ADDON_IDS.length];
      if (addonId !== undefined) store.dispatch({ kind: "toggle_addon", addonId });
    },
    addonsBack: () => {
      const presetId = store.getState().selectedPresetId;
      store.dispatch({
        kind: "set_view",
        view: presetId === "local" ? "datasources" : "channelspicker",
      });
    },
    nexusConfigConfirm: () => {
      // Select the focused option and proceed to start
      const options = ["docker", "source", "remote", "skip"] as const;
      const idx = store.getState().nexusConfigFocusedIndex;
      const mode = options[idx];
      if (mode !== undefined) {
        store.dispatch({ kind: "set_nexus_config_mode", mode });
      }
      handleAddonsConfirm();
    },
    nexusConfigBack: () => {
      store.dispatch({ kind: "set_view", view: "addons" });
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
      store.dispatch({ kind: "set_view", view: "channelspicker" });
    },
    engineSkip: () => {
      store.dispatch({ kind: "set_selected_engine", engine: undefined });
      store.dispatch({ kind: "set_view", view: "channelspicker" });
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
      dispatchCommand("stop", cmdDeps);
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
    openSessionPicker: () => {
      openSessionPicker().catch(() => {});
    },
    newSession: () => {
      const agents = store.getState().agents;
      const agent = agents[0];
      if (agent !== undefined) {
        debouncedPersist.flush();
        openAgentConsole(agent.agentId);
      }
    },
    refetchDebugTrace: () => {
      const sess = store.getState().activeSession;
      if (sess !== null) {
        const turnIndex = store.getState().debugView.selectedTurnIndex;
        store.dispatch({ kind: "set_debug_loading", loading: true });
        client
          .getDebugTrace(sess.agentId as string, turnIndex)
          .then((r) => {
            if (r.ok) store.dispatch({ kind: "set_debug_trace", trace: r.value });
            else store.dispatch({ kind: "set_debug_trace", trace: null });
          })
          .catch(() => {
            store.dispatch({ kind: "set_debug_loading", loading: false });
          });
      }
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

    // Set initial terminal width and listen for resize
    store.dispatch({ kind: "set_terminal_cols", cols: process.stdout.columns ?? 120 });
    process.stdout.on("resize", handleResize);

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
    await refreshForge().catch(() => {});
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
      // Governance events are pushed via SSE — no polling needed
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
    await refreshForge().catch(() => {});
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
    process.stdout.removeListener("resize", handleResize);
    if (resizeTimer !== undefined) {
      clearTimeout(resizeTimer);
      resizeTimer = undefined;
    }
    await persistCurrentSession(store, client).catch(() => {});
    stopEventStream();
    if (reactRoot !== null) {
      reactRoot.unmount();
      reactRoot = null;
    }
    syntaxStyle.destroy();
    if (tuiRenderer !== null) {
      // Guard against EBADF (errno: 9) when stdin is already closed during
      // process shutdown. The OpenTUI renderer's finalizeDestroy() calls
      // setRawMode(false) which emits an error event on the stdin TTY stream
      // when the file descriptor is gone. Without a listener, Node treats this
      // as an uncaught error and crashes the process.
      //
      // The listener is NOT removed — the renderer's process.on('exit') handler
      // also calls destroy(), which runs after stop() returns. Keeping the guard
      // prevents the crash in both the explicit and implicit destroy paths.
      process.stdin.on("error", () => {});
      try {
        tuiRenderer.destroy();
      } catch {
        // Non-fatal — process is exiting
      }
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
