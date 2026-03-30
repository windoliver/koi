/**
 * TUI root component — top-level React component composing all views.
 *
 * Renders status bar, switches between views (including welcome mode),
 * overlays command palette, and delegates keyboard shortcuts.
 */

import type { KeyEvent, SyntaxStyle } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useMemo, useState } from "react";
import { AgentSplitPane, type AgentPaneData } from "../components/agent-split-pane.js";
import type { TuiStore } from "../state/store.js";
import type { PresetInfo } from "../state/types.js";
import { COLORS } from "../theme.js";
import { AddonPickerView, AVAILABLE_ADDONS } from "./addon-picker-view.js";
import { decodePtyChunks } from "@koi/dashboard-client";
import { KNOWN_CHANNELS, KNOWN_MODELS } from "@koi/setup-core";
import { AgentListView } from "./agent-list-view.js";
import { AgentProcfsView } from "./agent-procfs-view.js";
import { ChannelsStepView } from "./channels-step-view.js";
import { ChannelsView } from "./channels-view.js";
import { CommandPaletteView } from "./command-palette-view.js";
import { ConsentView } from "./consent-view.js";
import { ConsoleView } from "./console-view.js";
import { CostView } from "./cost-view.js";
import { DataSourcesView } from "./data-sources-view.js";
import { DebugView } from "./debug-view.js";
import { DelegationView } from "./delegation-view.js";
import { DoctorView } from "./doctor-view.js";
import { EngineStepView } from "./engine-step-view.js";
import { ForgeView } from "./forge-view.js";
import { GatewayView } from "./gateway-view.js";
import { GovernanceView } from "./governance-view.js";
import { HandoffView } from "./handoff-view.js";
import { HarnessView } from "./harness-view.js";
import { HelpView } from "./help-view.js";
import { LogView } from "./log-view.js";
import { MailboxView } from "./mailbox-view.js";
import { MiddlewareView } from "./middleware-view.js";
import { ModelStepView } from "./model-step-view.js";
import { NexusBrowserView } from "./nexus-browser-view.js";
import { NexusConfigView } from "./nexus-config-view.js";
import { NexusView } from "./nexus-view.js";
import { ProcessTreeView } from "./process-tree-view.js";
import { ProgressView } from "./progress-view.js";
import { ScratchpadView } from "./scratchpad-view.js";
import { SchedulerView } from "./scheduler-view.js";
import { ServiceView } from "./service-view.js";
import { SessionPickerView } from "./session-picker-view.js";
import { SkillsView } from "./skills-view.js";
import type { SourceDetailData } from "./source-detail-view.js";
import { SourceDetailView } from "./source-detail-view.js";
import { StatusBarView } from "./status-bar-view.js";
import { useStoreState } from "./store-bridge.js";
import { SystemView } from "./system-view.js";
import { TaskBoardView } from "./taskboard-view.js";
import { TemporalView } from "./temporal-view.js";

/** Props for the root TUI component. */
export interface TuiRootProps {
  readonly store: TuiStore;
  readonly onConsoleInput: (text: string) => void;
  readonly onPaletteSelect: (commandId: string) => void;
  readonly onAgentSelect: (agentId: string) => void;
  readonly onPaletteCancel: () => void;
  readonly onKeyInput: (sequence: string) => boolean;
  readonly syntaxStyle?: SyntaxStyle | undefined;
  readonly onSessionSelect?: ((sessionId: string) => void) | undefined;
  readonly onSessionCancel?: (() => void) | undefined;
  readonly onDataSourceApprove?: ((name: string) => void) | undefined;
  readonly onDataSourceViewSchema?: ((name: string) => void) | undefined;
  readonly onConsentApprove?: ((name: string) => void) | undefined;
  readonly onConsentDeny?: ((name: string) => void) | undefined;
  readonly onConsentDetails?: ((name: string) => void) | undefined;
  readonly onConsentDismiss?: (() => void) | undefined;
  readonly onPresetSelect?: ((presetId: string) => void) | undefined;
  readonly onPresetDetails?: ((presetId: string) => void) | undefined;
  readonly onPresetBack?: (() => void) | undefined;
}

/**
 * Map a KeyEvent from OpenTUI to the raw byte sequence expected
 * by the keyboard handler.
 */
function mapKeyEventToSequence(key: KeyEvent, paletteActive?: boolean): string | null {
  if (key.ctrl) {
    switch (key.name) {
      case "c": return "\x03";
      case "n": return "\x0E";
      case "p": return "\x10";
      case "r": return "\x12";
      case "o": return "\x0F";
      case "g": return "\x07";
      case "f": return "\x06";
    }
  }
  if (key.name === "escape" || key.name === "Escape") return "\x1b";
  if (key.name === "return" || key.name === "Enter" || key.name === "Return") return "\r";
  if (key.name === "tab" || key.name === "Tab") return "\t";
  if (key.name === "up" || key.name === "ArrowUp") return "\x1b[A";
  if (key.name === "down" || key.name === "ArrowDown") return "\x1b[B";
  // When command palette is open, let printable keys fall through to filter input
  if (paletteActive === true) return null;
  // Single-char keys for view-specific shortcuts (includes 1-5 for tab switching)
  const SINGLE_KEYS = ["q", "a", "s", "j", "k", "y", "n", "d", "p", "t", "l", "+", "?", " ", "r", "1", "2", "3", "4", "5"];
  if (!key.ctrl && !key.meta && !key.shift && SINGLE_KEYS.includes(key.name)) {
    return key.name;
  }
  return null;
}

/** Root component for the TUI application. */
export function TuiRoot(props: TuiRootProps): React.ReactNode {
  const state = useStoreState(props.store);

  // Signal counters for palette navigation — incremented to trigger effects
  const [paletteNavDown, setPaletteNavDown] = useState(0);
  const [paletteNavUp, setPaletteNavUp] = useState(0);
  const [paletteConfirm, setPaletteConfirm] = useState(0);

  useKeyboard((key: KeyEvent) => {
    // In palette mode, only intercept control keys — let printable chars
    // fall through to the palette's <input> for filter typing.
    const inPalette = state.view === "palette";
    const seq = mapKeyEventToSequence(key, inPalette);
    if (seq !== null) {
      // Intercept arrows and Enter in palette mode for select navigation
      if (inPalette) {
        if (seq === "\x1b[B") { setPaletteNavDown((c) => c + 1); return; }
        if (seq === "\x1b[A") { setPaletteNavUp((c) => c + 1); return; }
        if (seq === "\r") { setPaletteConfirm((c) => c + 1); return; }
      }
      props.onKeyInput(seq);
    }
  });

  const view = state.view;
  const agents = state.agents;
  const session = state.activeSession;
  const pendingText = session?.pendingText ?? "";
  const isPalette = view === "palette";
  const backgroundView = session !== null ? "console" : view === "forge" ? "forge" : "agents";

  // Build split pane data from agents + PTY buffers
  // Limit visible split panes: 4 at full/compact, 2 at narrow/tooNarrow
  const maxPanes = state.layoutTier === "full" || state.layoutTier === "compact" ? 4 : 2;
  const splitPaneData: readonly AgentPaneData[] = useMemo(() => {
    if (view !== "splitpanes") return [];
    return agents.slice(0, maxPanes).map((agent) => {
      const chunks = state.ptyBuffers[agent.agentId] ?? [];
      const decoded = decodePtyChunks(chunks);
      const ptyData = decoded.length > 0 ? decoded : undefined;
      return {
        agentId: agent.agentId,
        agentName: agent.name,
        state: agent.state as AgentPaneData["state"],
        ptyData,
      };
    });
  }, [view, agents, state.ptyBuffers, maxPanes]);

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={COLORS.bg}>
      <StatusBarView state={state} />

      <box flexGrow={1}>
        {state.layoutTier === "tooNarrow" ? (
          /* Terminal too narrow — replace all content with warning */
          <box flexGrow={1} justifyContent="center" alignItems="center" flexDirection="column">
            <text fg={COLORS.yellow}>{`Terminal too narrow (${String(state.cols)} cols). Minimum: 80.`}</text>
          </box>
        ) : (<>

        {/* Welcome mode */}
        {view === "welcome" && (
          <box flexGrow={1} flexDirection="column" paddingLeft={2} paddingTop={1}>
            <text fg={COLORS.accent}><b>{"  Welcome to Koi"}</b></text>
            <text fg={COLORS.white}>
              {"  Koi is a self-extending agent engine. Select a preset to get started."}
            </text>
            <box marginTop={1} flexDirection="column" paddingLeft={2}>
              {state.presets.length > 0 ? (
                state.presets.map((preset: PresetInfo, i: number) => (
                  <box key={preset.id} height={1} flexDirection="row">
                    <text fg={i === state.selectedPresetIndex ? COLORS.cyan : COLORS.dim}>
                      {i === state.selectedPresetIndex ? " > " : "   "}
                    </text>
                    <text fg={i === state.selectedPresetIndex ? COLORS.white : COLORS.dim}>
                      {preset.id.padEnd(14)}
                    </text>
                    <text fg={COLORS.dim}>{preset.description}</text>
                  </box>
                ))
              ) : (
                <text fg={COLORS.dim}>{"  Loading presets..."}</text>
              )}
            </box>
            <box marginTop={2} paddingLeft={2} flexDirection="column">
              <text fg={COLORS.dim}><b>{"  Concepts:"}</b></text>
              <text fg={COLORS.dim}>{"  Manifest   — YAML file defining an agent"}</text>
              <text fg={COLORS.dim}>{"  Channel    — I/O interface to users (CLI, Slack, Discord)"}</text>
              <text fg={COLORS.dim}>{"  Middleware  — Intercepts model/tool calls (retry, audit)"}</text>
              <text fg={COLORS.dim}>{"  Engine     — Swappable agent loop"}</text>
              <text fg={COLORS.dim}>{"  Forge      — Self-improvement: agent behavior → tools"}</text>
              <text fg={COLORS.dim}>{"  Nexus      — Shared backend for data and coordination"}</text>
            </box>
            <box marginTop={1} paddingLeft={2}>
              <text fg={COLORS.dim}>{"  j/k:navigate  Enter:select  ?:details  q:quit"}</text>
            </box>
          </box>
        )}

        {/* Preset detail view */}
        {view === "presetdetail" && state.activePresetDetail !== null && (
          <box flexGrow={1} flexDirection="column" paddingLeft={2} paddingTop={1}>
            <text fg={COLORS.cyan}><b>{`  ${state.activePresetDetail.id}`}</b></text>
            <box marginTop={1} paddingLeft={2} flexDirection="column">
              <text>{`Nexus: ${state.activePresetDetail.nexusMode}`}</text>
              {state.activePresetDetail.demoPack !== undefined && (
                <text>{`Demo pack: ${state.activePresetDetail.demoPack}`}</text>
              )}
              {state.activePresetDetail.agentRoles !== undefined && state.activePresetDetail.agentRoles.length > 0 && (
                <box flexDirection="column" marginTop={1}>
                  <text fg={COLORS.cyan}><b>{"Agent roles:"}</b></text>
                  {state.activePresetDetail.agentRoles.map((role) => (
                    <text key={role.role} fg={COLORS.dim}>{`  ${role.role} — ${role.description}`}</text>
                  ))}
                </box>
              )}
              {Object.entries(state.activePresetDetail.stacks).filter(([, v]) => v === true).length > 0 && (
                <box marginTop={1} flexDirection="column">
                  <text fg={COLORS.cyan}><b>{"Stacks:"}</b></text>
                  <text fg={COLORS.dim}>
                    {"  " + Object.entries(state.activePresetDetail.stacks)
                      .filter(([, v]) => v === true)
                      .map(([k]) => k)
                      .join(", ")}
                  </text>
                </box>
              )}
              {state.activePresetDetail.prompts !== undefined && state.activePresetDetail.prompts.length > 0 && (
                <box marginTop={1} flexDirection="column">
                  <text fg={COLORS.cyan}><b>{"Sample prompts:"}</b></text>
                  {state.activePresetDetail.prompts.map((p, i) => (
                    <text key={i} fg={COLORS.dim}><i>{`  "${p}"`}</i></text>
                  ))}
                </box>
              )}
            </box>
            <box marginTop={1} paddingLeft={2}>
              <text fg={COLORS.dim}>{"  Enter:select  Esc:back  q:quit"}</text>
            </box>
          </box>
        )}

        {/* Name input step */}
        {view === "nameinput" && (
          <box flexGrow={1} flexDirection="column" paddingLeft={2} paddingTop={1}>
            <text fg={COLORS.cyan}><b>{"  Agent Name"}</b></text>
            <box marginTop={1} paddingLeft={2} flexDirection="column">
              <text fg={COLORS.dim}>{"  Enter a name for your agent:"}</text>
              <box marginTop={1} paddingLeft={2}>
                <textarea
                  height={1}
                  focused={true}
                  placeholder={state.agentNameInput}
                  placeholderColor={COLORS.dim}
                  backgroundColor={COLORS.bg}
                  textColor={COLORS.white}
                  focusedBackgroundColor="#001a33"
                  focusedTextColor={COLORS.white}
                  onContentChange={(ref) => {
                    if (ref !== null && typeof ref === "object" && "plainText" in ref) {
                      const text = (ref as { readonly plainText: string }).plainText;
                      props.store.dispatch({ kind: "set_agent_name_input", name: text });
                    }
                  }}
                />
              </box>
            </box>
            <box marginTop={1} paddingLeft={2}>
              <text fg={COLORS.dim}>{"  Enter:confirm  Esc:back"}</text>
            </box>
          </box>
        )}

        {/* Add-on picker step */}
        {view === "addons" && (
          <AddonPickerView
            addons={AVAILABLE_ADDONS}
            selected={state.selectedAddons}
            focusedIndex={state.addonFocusedIndex}
            onToggle={(id) => { props.store.dispatch({ kind: "toggle_addon", addonId: id }); }}
            onConfirm={() => { /* handled by keyboard */ }}
            onSkip={() => { /* handled by keyboard */ }}
            focused={true}
          />
        )}

        {/* Nexus config step */}
        {view === "nexusconfig" && (
          <NexusConfigView
            focusedIndex={state.nexusConfigFocusedIndex}
            selectedMode={state.nexusConfigMode}
            sourcePath={state.nexusSourcePath}
            remoteUrl={state.nexusRemoteUrl}
          />
        )}

        {/* Boardroom views */}
        {(view === "agents" || (isPalette && backgroundView === "agents")) && (
          <AgentListView agents={agents} onSelect={props.onAgentSelect} focused={view === "agents"} zoomLevel={state.zoomLevel} listMode={state.agentListMode} />
        )}

        {(view === "console" || (isPalette && backgroundView === "console")) && (
          <ConsoleView
            session={session}
            pendingText={pendingText}
            onSubmit={props.onConsoleInput}
            focused={view === "console"}
            syntaxStyle={props.syntaxStyle}
            zoomLevel={state.zoomLevel}
            cols={state.cols}
          />
        )}

        {view === "datasources" && (
          <DataSourcesView
            sources={state.dataSources}
            loading={state.dataSourcesLoading}
            selectedIndex={state.selectedDataSourceIndex}
            onApprove={props.onDataSourceApprove}
            onViewSchema={props.onDataSourceViewSchema}
            focused={true}
            zoomLevel={state.zoomLevel}
          />
        )}

        {view === "sourcedetail" && (
          <SourceDetailView
            data={state.sourceDetail as SourceDetailData | null}
            loading={state.sourceDetailLoading}
            onApprove={props.onDataSourceApprove}
            onViewSchema={props.onDataSourceViewSchema}
            onBack={() => { props.store.dispatch({ kind: "set_view", view: "datasources" }); }}
            focused={true}
            syntaxStyle={props.syntaxStyle}
            zoomLevel={state.zoomLevel}
          />
        )}

        {view === "consent" && state.pendingConsent !== undefined && (
          <ConsentView
            sources={state.pendingConsent}
            onApprove={(name) => props.onConsentApprove?.(name)}
            onDeny={(name) => props.onConsentDeny?.(name)}
            onDetails={(name) => props.onConsentDetails?.(name)}
            onDismiss={() => props.onConsentDismiss?.()}
            focused={true}
            zoomLevel={state.zoomLevel}
          />
        )}

        {(view === "forge" || (isPalette && backgroundView === "forge")) && (
          <ForgeView state={state} focused={view === "forge"} zoomLevel={state.zoomLevel} layoutTier={state.layoutTier} />
        )}

        {view === "sessions" && (
          <SessionPickerView
            sessions={state.sessionPickerEntries}
            onSelect={props.onSessionSelect ?? (() => {})}
            onCancel={props.onSessionCancel ?? (() => {})}
            focused={true}
            loading={state.sessionPickerLoading}
            zoomLevel={state.zoomLevel}
          />
        )}

        {/* Model selection step */}
        {view === "model" && (
          <ModelStepView
            models={[...KNOWN_MODELS]}
            selectedModel={state.selectedModel}
            focusedIndex={state.modelFocusedIndex}
            onSelect={(model) => { props.store.dispatch({ kind: "set_selected_model", model }); }}
          />
        )}

        {/* Engine selection step */}
        {view === "engine" && (
          <EngineStepView selectedEngine={state.selectedEngine} />
        )}

        {/* Channel selection step (wizard flow) */}
        {view === "channelspicker" && (
          <ChannelsStepView
            channels={[...KNOWN_CHANNELS]}
            selected={[...state.selectedChannels]}
            focusedIndex={state.channelFocusedIndex}
          />
        )}

        {/* Progress view — setup phases */}
        {view === "progress" && (
          <ProgressView
            phases={state.phaseProgress}
            setupRunning={state.setupRunning}
          />
        )}

        {/* Service management view */}
        {view === "service" && (
          <ServiceView
            status={state.serviceStatus}
            demoPacks={state.demoPacks}
            pendingStopConfirm={state.pendingStopConfirm}
          />
        )}

        {/* Doctor view */}
        {view === "doctor" && (
          <DoctorView checks={state.doctorChecks} />
        )}

        {/* Log view */}
        {view === "logs" && (
          <LogView entries={state.logBuffer} logLevel={state.logLevel} />
        )}

        {/* Split panes — per-agent terminal output */}
        {view === "splitpanes" && (
          <AgentSplitPane
            panes={splitPaneData}
            focusedIndex={state.focusedPaneIndex}
            onFocusChange={(index) => {
              props.store.dispatch({ kind: "set_focused_pane", index });
            }}
            onZoomToggle={() => {
              props.store.dispatch({ kind: "cycle_zoom" });
            }}
            maxScrollback={500}
          />
        )}

        {/* Domain views */}
        {view === "skills" && (
          <SkillsView skillsView={state.skillsView} focused={true} zoomLevel={state.zoomLevel} />
        )}
        {view === "channels" && (
          <ChannelsView channelsView={state.channelsView} focused={true} zoomLevel={state.zoomLevel} />
        )}
        {view === "system" && (
          <SystemView systemView={state.systemView} focused={true} zoomLevel={state.zoomLevel} />
        )}
        {view === "nexus" && (
          <NexusView nexusView={state.nexusView} focused={true} zoomLevel={state.zoomLevel} />
        )}
        {view === "gateway" && (
          <GatewayView gatewayView={state.gatewayView} focused={true} zoomLevel={state.zoomLevel} />
        )}
        {view === "temporal" && (
          <TemporalView temporalView={state.temporalView} focused={true} zoomLevel={state.zoomLevel} />
        )}
        {view === "scheduler" && (
          <SchedulerView schedulerView={state.schedulerView} focused={true} zoomLevel={state.zoomLevel} />
        )}
        {view === "taskboard" && (
          <TaskBoardView taskBoardView={state.taskBoardView} focused={true} zoomLevel={state.zoomLevel} />
        )}
        {view === "harness" && (
          <HarnessView harnessView={state.harnessView} focused={true} zoomLevel={state.zoomLevel} />
        )}
        {view === "governance" && (
          <GovernanceView governanceView={state.governanceView} focused={true} zoomLevel={state.zoomLevel} />
        )}
        {view === "cost" && (
          <CostView costView={state.costView} focused={true} zoomLevel={state.zoomLevel} cols={state.cols} layoutTier={state.layoutTier} />
        )}
        {view === "middleware" && (
          <MiddlewareView middlewareView={state.middlewareView} focused={true} zoomLevel={state.zoomLevel} />
        )}
        {view === "processtree" && (
          <ProcessTreeView processTreeView={state.processTreeView} focused={true} zoomLevel={state.zoomLevel} />
        )}
        {view === "agentprocfs" && (
          <AgentProcfsView agentProcfsView={state.agentProcfsView} focused={true} zoomLevel={state.zoomLevel} />
        )}
        {view === "debug" && (
          <DebugView debugView={state.debugView} focused={true} zoomLevel={state.zoomLevel} />
        )}
        {view === "delegation" && (
          <DelegationView delegationView={state.delegationView} focused={true} zoomLevel={state.zoomLevel} />
        )}
        {view === "handoffs" && (
          <HandoffView handoffView={state.handoffView} focused={true} zoomLevel={state.zoomLevel} />
        )}
        {view === "scratchpad" && (
          <ScratchpadView scratchpadView={state.scratchpadView} focused={true} zoomLevel={state.zoomLevel} />
        )}
        {view === "mailbox" && (
          <MailboxView mailboxView={state.mailboxView} focused={true} zoomLevel={state.zoomLevel} />
        )}
        {view === "files" && (
          <NexusBrowserView nexusBrowser={state.nexusBrowser} focused={true} zoomLevel={state.zoomLevel} />
        )}

        {/* Help overlay */}
        {view === "help" && (
          <HelpView currentView={state.viewHistory[state.viewHistory.length - 1] ?? "agents"} />
        )}

        {/* Command palette overlay */}
        <CommandPaletteView
          visible={isPalette}
          onSelect={props.onPaletteSelect}
          onCancel={props.onPaletteCancel}
          focused={isPalette}
          capabilities={state.capabilities}
          navigateDown={paletteNavDown}
          navigateUp={paletteNavUp}
          confirmSignal={paletteConfirm}
        />

        {/* Toast notification — transient feedback overlay */}
        {state.toast !== null && (
          <box height={1} flexDirection="row" justifyContent="center">
            <text fg={state.toast.kind === "success" ? "#22C55E" : "#EF4444"}>
              {state.toast.kind === "success" ? " ✓ " : " ✘ "}{state.toast.message}
            </text>
          </box>
        )}

        </>)}
      </box>
    </box>
  );
}
