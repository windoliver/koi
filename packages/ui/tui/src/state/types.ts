/**
 * TUI state types — pure data definitions for the terminal console.
 *
 * Re-exports ChatMessage and DashboardClientError from @koi/dashboard-client
 * to keep backward compatibility. TUI-specific state types defined here.
 */

import type {
  AgentProcfs,
  CheckpointEntry,
  CronSchedule,
  DashboardAgentSummary,
  DashboardChannelSummary,
  DashboardEventBatch,
  DashboardSkillSummary,
  DashboardSystemMetrics,
  DataSourceSummary,
  ForgeDashboardEvent,
  GatewayTopology,
  HarnessStatus,
  MiddlewareChain,
  MonitorDashboardEvent,
  ProcessTreeSnapshot,
  SchedulerDeadLetterEntry,
  SchedulerStats,
  SchedulerTaskSummary,
  TaskBoardSnapshot,
  TemporalHealth,
  WorkflowDetail,
  WorkflowSummary,
} from "@koi/dashboard-types";
import type { PhaseProgress } from "@koi/setup-core";
import type {
  AgentProcfsViewState,
  ChannelsViewState,
  CostViewState,
  DebugViewState,
  DelegationViewState,
  GatewayViewState,
  GovernanceAgentSanction,
  GovernancePendingAction,
  GovernancePendingApproval,
  GovernanceViewState,
  GovernanceViolation,
  HandoffViewState,
  HarnessViewState,
  MailboxViewState,
  MiddlewareViewState,
  NexusBrowserState,
  NexusViewState,
  ProcessTreeViewState,
  SchedulerViewState,
  ScratchpadViewState,
  SkillsViewState,
  SystemViewState,
  TaskBoardViewState,
  TemporalViewState,
  TuiCapabilities,
} from "./domain-types.js";
import {
  createInitialAgentProcfsView,
  createInitialChannelsView,
  createInitialCostView,
  createInitialDebugView,
  createInitialDelegationView,
  createInitialGatewayView,
  createInitialGovernanceView,
  createInitialHandoffView,
  createInitialHarnessView,
  createInitialMailboxView,
  createInitialMiddlewareView,
  createInitialNexusBrowser,
  createInitialNexusView,
  createInitialProcessTreeView,
  createInitialSchedulerView,
  createInitialScratchpadView,
  createInitialSkillsView,
  createInitialSystemView,
  createInitialTaskBoardView,
  createInitialTemporalView,
} from "./domain-types.js";

// Re-export shared types from dashboard-client
/** TUI-specific error alias for backward compat. */
export type {
  ChatMessage,
  DashboardClientError,
  DashboardClientError as TuiError,
} from "@koi/dashboard-client";

// ─── Session State ───────────────────────────────────────────────────

/** Active chat session state. */
export interface SessionState {
  readonly agentId: string;
  readonly sessionId: string;
  readonly messages: readonly import("@koi/dashboard-client").ChatMessage[];
  /** Buffered streaming tokens not yet flushed to messages. */
  readonly pendingText: string;
  readonly isStreaming: boolean;
}

// ─── View Types ──────────────────────────────────────────────────────

/** Which TUI view is currently active. */
export type TuiView =
  | "addons"
  | "agents"
  | "agentprocfs"
  | "channels"
  | "consent"
  | "console"
  | "cost"
  | "datasources"
  | "debug"
  | "delegation"
  | "doctor"
  | "engine"
  | "files"
  | "forge"
  | "gateway"
  | "governance"
  | "handoffs"
  | "harness"
  | "logs"
  | "mailbox"
  | "middleware"
  | "model"
  | "nameinput"
  | "nexus"
  | "nexusconfig"
  | "palette"
  | "presetdetail"
  | "processtree"
  | "progress"
  | "scheduler"
  | "scratchpad"
  | "service"
  | "sessions"
  | "skills"
  | "sourcedetail"
  | "splitpanes"
  | "system"
  | "taskboard"
  | "temporal"
  | "welcome";

/** Panel zoom level — cycles with +/Esc. */
export type ZoomLevel = "normal" | "half" | "full";

/** Admin API connection state. */
export type ConnectionStatus = "connected" | "reconnecting" | "disconnected";

// ─── Application State ──────────────────────────────────────────────

/** A saved session entry for the session picker. */
export interface SessionPickerEntry {
  readonly sessionId: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly connectedAt: number;
  readonly messageCount: number;
  /** First user message snippet for distinguishing sessions. */
  readonly preview: string;
  /** Path to the session log file (for restore). */
  readonly logPath?: string | undefined;
}

/** Forge brick summary for TUI display. */
export interface TuiBrickSummary {
  readonly name: string;
  readonly status: string;
  readonly fitness: number;
}

/** Preset info for the welcome screen. */
export interface PresetInfo {
  readonly id: string;
  readonly description: string;
  readonly nexusMode: string;
  readonly demoPack: string | undefined;
  readonly services: Readonly<Record<string, unknown>>;
  readonly stacks: Readonly<Record<string, boolean | undefined>>;
  readonly agentRoles?: readonly { readonly role: string; readonly description: string }[];
  readonly prompts?: readonly string[];
}

/** Agent list display mode — flat list or hierarchy tree. */
export type AgentListMode = "flat" | "tree";

/** Nexus configuration mode for the wizard. */
export type NexusConfigMode = "skip" | "docker" | "source" | "remote";

/** Available Nexus config options. */
export const NEXUS_CONFIG_OPTIONS: readonly {
  readonly id: NexusConfigMode;
  readonly label: string;
  readonly description: string;
}[] = [
  { id: "docker", label: "Docker", description: "Run Nexus via Docker Compose (default)" },
  {
    id: "source",
    label: "Build from source",
    description: "Build and run from local ~/nexus repo",
  },
  { id: "remote", label: "Remote URL", description: "Connect to an existing Nexus instance" },
  { id: "skip", label: "Skip", description: "No Nexus (local-only mode)" },
] as const;

/** Log level for filtering. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** A structured log entry. */
export interface LogEntry {
  readonly level: LogLevel;
  readonly source: string;
  readonly message: string;
  readonly timestamp: number;
}

/** Service subsystem status for the service view. */
export interface ServiceStatusState {
  readonly status: string;
  readonly uptimeMs: number;
  readonly subsystems: Readonly<
    Record<string, { readonly status: string; readonly latencyMs?: number | undefined }>
  >;
  readonly ports: readonly {
    readonly port: number;
    readonly service: string;
    readonly status: string;
  }[];
}

/** A single doctor diagnostic check result. */
export interface DoctorCheck {
  readonly id: string;
  readonly label: string;
  readonly status: "pass" | "fail" | "warn" | "running";
  readonly detail?: string | undefined;
}

/** Maximum log entries kept in buffer. */
export const MAX_LOG_BUFFER = 500;

/** Complete TUI application state. Immutable — new object on every update. */
export interface TuiState {
  readonly view: TuiView;
  readonly agents: readonly DashboardAgentSummary[];
  readonly selectedAgentIndex: number;
  /** Agent list display mode — toggled by /tree. */
  readonly agentListMode: AgentListMode;
  readonly activeSession: SessionState | null;
  readonly connectionStatus: ConnectionStatus;
  readonly error: import("@koi/dashboard-client").DashboardClientError | null;
  readonly adminUrl: string;
  /** Last received SSE sequence number for gap detection. */
  readonly lastEventSeq: number;
  /** Session picker entries. */
  readonly sessionPickerEntries: readonly SessionPickerEntry[];
  /** Whether the session picker is loading. */
  readonly sessionPickerLoading: boolean;
  /** Discovered data sources. */
  readonly dataSources: readonly DataSourceSummary[];
  /** Whether data sources are loading. */
  readonly dataSourcesLoading: boolean;
  /** Selected data source index. */
  readonly selectedDataSourceIndex: number;
  /** Source detail data for the detail view. */
  readonly sourceDetail: Readonly<Record<string, unknown>> | null;
  /** Whether source detail is loading. */
  readonly sourceDetailLoading: boolean;
  /** Pending consent data sources awaiting user approval. */
  readonly pendingConsent: readonly DataSourceSummary[] | undefined;
  /** Forge self-improvement events buffer. */
  readonly forgeEvents: readonly ForgeDashboardEvent[];
  /** Monitor anomaly events buffer. */
  readonly monitorEvents: readonly MonitorDashboardEvent[];
  /** Forge brick summaries by ID. */
  readonly forgeBricks: Readonly<Record<string, TuiBrickSummary>>;
  /** Forge sparkline data by brick ID. */
  readonly forgeSparklines: Readonly<Record<string, readonly number[]>>;
  /** Selected forge brick index for keyboard navigation. */
  readonly forgeSelectedBrickIndex: number;
  /** Current zoom level for focused panel. */
  readonly zoomLevel: ZoomLevel;
  /** Available presets for the welcome screen. */
  readonly presets: readonly PresetInfo[];
  /** Selected preset index (welcome screen). */
  readonly selectedPresetIndex: number;
  /** Active preset detail being viewed. */
  readonly activePresetDetail: PresetInfo | null;
  /** Selected preset ID (after choosing from welcome screen). */
  readonly selectedPresetId: string | null;
  /** Agent name input by user during setup. */
  readonly agentNameInput: string;
  /** Selected add-on IDs during setup. */
  readonly selectedAddons: ReadonlySet<string>;
  /** Focused add-on index in the picker. */
  readonly addonFocusedIndex: number;
  /** Selected model during setup. */
  readonly selectedModel: string;
  /** Focused model index during model selection. */
  readonly modelFocusedIndex: number;
  /** Selected engine during setup. */
  readonly selectedEngine: string | undefined;
  /** Selected channels during setup. */
  readonly selectedChannels: readonly string[];
  /** Focused channel index during channel selection. */
  readonly channelFocusedIndex: number;
  /** Phase progress entries for the progress view. */
  readonly phaseProgress: readonly PhaseProgress[];
  /** Whether setup is currently running. */
  readonly setupRunning: boolean;
  /** Structured log buffer. */
  readonly logBuffer: readonly LogEntry[];
  /** Current log level filter. */
  readonly logLevel: LogLevel;
  /** Service subsystem status. */
  readonly serviceStatus: ServiceStatusState | null;
  /** Doctor diagnostic check results. */
  readonly doctorChecks: readonly DoctorCheck[];
  /** Per-agent PTY output buffers (base64 chunks). */
  readonly ptyBuffers: Readonly<Record<string, readonly string[]>>;
  /** Per-agent sessions for split-pane mode. */
  readonly splitSessions: Readonly<Record<string, SessionState>>;
  /** Index of focused pane in split view. */
  readonly focusedPaneIndex: number;
  // ─── Domain view slices ──────────────────────────────────────────
  readonly skillsView: SkillsViewState;
  readonly channelsView: ChannelsViewState;
  readonly systemView: SystemViewState;
  readonly nexusView: NexusViewState;
  readonly gatewayView: GatewayViewState;
  readonly temporalView: TemporalViewState;
  readonly schedulerView: SchedulerViewState;
  readonly taskBoardView: TaskBoardViewState;
  readonly harnessView: HarnessViewState;
  readonly governanceView: GovernanceViewState;
  readonly costView: CostViewState;
  readonly debugView: DebugViewState;
  readonly middlewareView: MiddlewareViewState;
  readonly processTreeView: ProcessTreeViewState;
  readonly agentProcfsView: AgentProcfsViewState;
  readonly delegationView: DelegationViewState;
  readonly handoffView: HandoffViewState;
  readonly scratchpadView: ScratchpadViewState;
  readonly mailboxView: MailboxViewState;
  /** Override agent ID for mailbox — set by /mailbox <agentId>. */
  readonly mailboxTargetAgentId: string | null;
  readonly nexusBrowser: NexusBrowserState;
  /** Server capabilities — which subsystems are available. */
  readonly capabilities: TuiCapabilities | null;
  /** Available demo packs from /demo list. */
  readonly demoPacks: readonly { readonly id: string; readonly description: string }[];
  /** Whether /stop confirmation is pending. */
  readonly pendingStopConfirm: boolean;
  /** Selected Nexus mode during wizard: "skip", "docker", "source", "remote". */
  readonly nexusConfigMode: NexusConfigMode;
  /** Focused index in Nexus config picker. */
  readonly nexusConfigFocusedIndex: number;
  /** Nexus source path (for "source" mode). */
  readonly nexusSourcePath: string;
  /** Nexus remote URL (for "remote" mode). */
  readonly nexusRemoteUrl: string;
  /** Whether to build Nexus from source. */
  readonly nexusBuildFromSource: boolean;
}

/** App mode: welcome (no admin API) or boardroom (connected). */
export type TuiMode = "welcome" | "boardroom";

/** Create initial TUI state for a given admin URL and mode. */
export function createInitialState(adminUrl: string, mode: TuiMode = "boardroom"): TuiState {
  return {
    view: mode === "welcome" ? "welcome" : "agents",
    agents: [],
    selectedAgentIndex: 0,
    agentListMode: "flat" as AgentListMode,
    activeSession: null,
    connectionStatus: "disconnected",
    error: null,
    adminUrl,
    lastEventSeq: 0,
    sessionPickerEntries: [],
    sessionPickerLoading: false,
    dataSources: [],
    dataSourcesLoading: false,
    selectedDataSourceIndex: 0,
    sourceDetail: null,
    sourceDetailLoading: false,
    pendingConsent: undefined,
    forgeEvents: [],
    monitorEvents: [],
    forgeBricks: {},
    forgeSparklines: {},
    forgeSelectedBrickIndex: 0,
    zoomLevel: "normal",
    presets: [],
    selectedPresetIndex: 0,
    activePresetDetail: null,
    selectedPresetId: null,
    agentNameInput: "",
    selectedAddons: new Set<string>(),
    addonFocusedIndex: 0,
    selectedModel: "anthropic:claude-sonnet-4-5-20250929",
    modelFocusedIndex: 0,
    selectedEngine: undefined,
    selectedChannels: ["cli"],
    channelFocusedIndex: 0,
    phaseProgress: [],
    setupRunning: false,
    logBuffer: [],
    logLevel: "info",
    serviceStatus: null,
    doctorChecks: [],
    ptyBuffers: {},
    splitSessions: {},
    focusedPaneIndex: 0,
    skillsView: createInitialSkillsView(),
    channelsView: createInitialChannelsView(),
    systemView: createInitialSystemView(),
    nexusView: createInitialNexusView(),
    gatewayView: createInitialGatewayView(),
    temporalView: createInitialTemporalView(),
    schedulerView: createInitialSchedulerView(),
    taskBoardView: createInitialTaskBoardView(),
    harnessView: createInitialHarnessView(),
    governanceView: createInitialGovernanceView(),
    costView: createInitialCostView(),
    debugView: createInitialDebugView(),
    middlewareView: createInitialMiddlewareView(),
    processTreeView: createInitialProcessTreeView(),
    agentProcfsView: createInitialAgentProcfsView(),
    delegationView: createInitialDelegationView(),
    handoffView: createInitialHandoffView(),
    scratchpadView: createInitialScratchpadView(),
    mailboxView: createInitialMailboxView(),
    mailboxTargetAgentId: null,
    nexusBrowser: createInitialNexusBrowser(),
    capabilities: null,
    demoPacks: [],
    pendingStopConfirm: false,
    nexusConfigMode: "docker" as NexusConfigMode,
    nexusConfigFocusedIndex: 0,
    nexusSourcePath: "~/nexus",
    nexusRemoteUrl: "",
    nexusBuildFromSource: false,
  };
}

// ─── Actions ─────────────────────────────────────────────────────────

/** Discriminated union of all state-changing actions. */
export type TuiAction =
  | { readonly kind: "set_view"; readonly view: TuiView }
  | {
      readonly kind: "set_agents";
      readonly agents: readonly DashboardAgentSummary[];
    }
  | { readonly kind: "select_agent"; readonly index: number }
  | { readonly kind: "set_session"; readonly session: SessionState | null }
  | { readonly kind: "append_tokens"; readonly text: string }
  | { readonly kind: "flush_tokens" }
  | {
      readonly kind: "add_message";
      readonly message: import("@koi/dashboard-client").ChatMessage;
    }
  | {
      readonly kind: "update_tool_result";
      readonly toolCallId: string;
      readonly result: string;
    }
  | {
      readonly kind: "set_connection_status";
      readonly status: ConnectionStatus;
    }
  | { readonly kind: "set_streaming"; readonly isStreaming: boolean }
  | {
      readonly kind: "set_error";
      readonly error: import("@koi/dashboard-client").DashboardClientError | null;
    }
  | {
      readonly kind: "apply_event_batch";
      readonly batch: DashboardEventBatch;
    }
  | {
      readonly kind: "set_session_picker";
      readonly entries: readonly SessionPickerEntry[];
      readonly loading: boolean;
    }
  | {
      readonly kind: "set_data_sources";
      readonly sources: readonly DataSourceSummary[];
    }
  | {
      readonly kind: "set_data_sources_loading";
      readonly loading: boolean;
    }
  | {
      readonly kind: "select_data_source";
      readonly index: number;
    }
  | {
      readonly kind: "set_source_detail";
      readonly detail: Readonly<Record<string, unknown>> | null;
    }
  | {
      readonly kind: "set_source_detail_loading";
      readonly loading: boolean;
    }
  | {
      readonly kind: "set_pending_consent";
      readonly sources: readonly DataSourceSummary[];
    }
  | { readonly kind: "clear_pending_consent" }
  | {
      readonly kind: "apply_forge_batch";
      readonly events: readonly ForgeDashboardEvent[];
    }
  | {
      readonly kind: "apply_monitor_event";
      readonly event: MonitorDashboardEvent;
    }
  | { readonly kind: "set_zoom_level"; readonly level: ZoomLevel }
  | { readonly kind: "cycle_zoom" }
  | {
      readonly kind: "set_presets";
      readonly presets: readonly PresetInfo[];
    }
  | { readonly kind: "select_preset"; readonly index: number }
  | {
      readonly kind: "set_active_preset_detail";
      readonly detail: PresetInfo | null;
    }
  | { readonly kind: "set_selected_preset_id"; readonly presetId: string }
  | { readonly kind: "set_agent_name_input"; readonly name: string }
  | { readonly kind: "toggle_addon"; readonly addonId: string }
  | { readonly kind: "set_addon_focused_index"; readonly index: number }
  | {
      readonly kind: "append_pty_data";
      readonly agentId: string;
      readonly data: string;
    }
  | { readonly kind: "clear_pty_buffer"; readonly agentId: string }
  | {
      readonly kind: "set_split_session";
      readonly agentId: string;
      readonly session: SessionState;
    }
  | {
      readonly kind: "remove_split_session";
      readonly agentId: string;
    }
  | {
      readonly kind: "append_split_tokens";
      readonly agentId: string;
      readonly text: string;
    }
  | {
      readonly kind: "flush_split_tokens";
      readonly agentId: string;
    }
  | {
      readonly kind: "set_focused_pane";
      readonly index: number;
    }
  // ─── Wizard/setup actions ─────────────────────────────────────────
  | { readonly kind: "set_selected_model"; readonly model: string }
  | { readonly kind: "set_model_focused_index"; readonly index: number }
  | { readonly kind: "set_selected_engine"; readonly engine: string | undefined }
  | { readonly kind: "set_selected_channels"; readonly channels: readonly string[] }
  | { readonly kind: "set_channel_focused_index"; readonly index: number }
  | { readonly kind: "toggle_channel"; readonly channel: string }
  | { readonly kind: "append_phase_progress"; readonly progress: PhaseProgress }
  | { readonly kind: "set_setup_running"; readonly running: boolean }
  | { readonly kind: "clear_phase_progress" }
  // ─── Service/log actions ─────────────────────────────────────────
  | { readonly kind: "append_log"; readonly entry: LogEntry }
  | { readonly kind: "set_log_level"; readonly level: LogLevel }
  | { readonly kind: "clear_logs" }
  | { readonly kind: "set_service_status"; readonly status: ServiceStatusState | null }
  | { readonly kind: "set_doctor_checks"; readonly checks: readonly DoctorCheck[] }
  | { readonly kind: "append_doctor_check"; readonly check: DoctorCheck }
  | { readonly kind: "clear_doctor_checks" }
  | {
      readonly kind: "set_demo_packs";
      readonly packs: readonly { readonly id: string; readonly description: string }[];
    }
  | { readonly kind: "set_pending_stop" }
  | { readonly kind: "clear_pending_stop" }
  // ─── Nexus config actions ─────────────────────────────────────────
  | { readonly kind: "set_nexus_config_mode"; readonly mode: NexusConfigMode }
  | { readonly kind: "set_nexus_config_focused_index"; readonly index: number }
  | { readonly kind: "set_nexus_source_path"; readonly path: string }
  | { readonly kind: "set_nexus_remote_url"; readonly url: string }
  | { readonly kind: "set_nexus_build_from_source"; readonly build: boolean }
  // ─── Domain view actions ───────────────────────────────────────────
  | {
      readonly kind: "apply_skill_event";
      readonly event: import("@koi/dashboard-types").SkillDashboardEvent;
    }
  | {
      readonly kind: "apply_channel_event";
      readonly event: import("@koi/dashboard-types").ChannelDashboardEvent;
    }
  | {
      readonly kind: "apply_system_event";
      readonly event: import("@koi/dashboard-types").SystemDashboardEvent;
    }
  | {
      readonly kind: "apply_nexus_event";
      readonly event: import("@koi/dashboard-types").NexusDashboardEvent;
    }
  | {
      readonly kind: "apply_gateway_event";
      readonly event: import("@koi/dashboard-types").GatewayDashboardEvent;
    }
  | {
      readonly kind: "apply_temporal_event";
      readonly event: import("@koi/dashboard-types").TemporalDashboardEvent;
    }
  | {
      readonly kind: "apply_scheduler_event";
      readonly event: import("@koi/dashboard-types").SchedulerDashboardEvent;
    }
  | {
      readonly kind: "apply_taskboard_event";
      readonly event: import("@koi/dashboard-types").TaskBoardDashboardEvent;
    }
  | {
      readonly kind: "apply_harness_event";
      readonly event: import("@koi/dashboard-types").HarnessDashboardEvent;
    }
  | { readonly kind: "set_capabilities"; readonly capabilities: TuiCapabilities }
  | { readonly kind: "set_gateway_topology"; readonly topology: GatewayTopology }
  | { readonly kind: "set_temporal_health"; readonly health: TemporalHealth }
  | { readonly kind: "set_temporal_workflows"; readonly workflows: readonly WorkflowSummary[] }
  | { readonly kind: "set_temporal_workflow_detail"; readonly detail: WorkflowDetail | null }
  | { readonly kind: "select_temporal_workflow"; readonly index: number }
  | { readonly kind: "set_scheduler_stats"; readonly stats: SchedulerStats }
  | { readonly kind: "set_scheduler_tasks"; readonly tasks: readonly SchedulerTaskSummary[] }
  | { readonly kind: "set_scheduler_schedules"; readonly schedules: readonly CronSchedule[] }
  | {
      readonly kind: "set_scheduler_dead_letters";
      readonly entries: readonly SchedulerDeadLetterEntry[];
    }
  | { readonly kind: "set_taskboard_snapshot"; readonly snapshot: TaskBoardSnapshot }
  | { readonly kind: "set_harness_status"; readonly status: HarnessStatus }
  | { readonly kind: "set_harness_checkpoints"; readonly checkpoints: readonly CheckpointEntry[] }
  | { readonly kind: "set_middleware_chain"; readonly chain: MiddlewareChain }
  | { readonly kind: "set_middleware_loading"; readonly loading: boolean }
  | { readonly kind: "set_process_tree"; readonly snapshot: ProcessTreeSnapshot }
  | { readonly kind: "set_process_tree_loading"; readonly loading: boolean }
  | { readonly kind: "set_agent_procfs"; readonly procfs: AgentProcfs }
  | { readonly kind: "set_agent_procfs_loading"; readonly loading: boolean }
  | {
      readonly kind: "add_governance_approval";
      readonly approval: GovernancePendingApproval;
    }
  | { readonly kind: "remove_governance_approval"; readonly id: string }
  | { readonly kind: "add_governance_violation"; readonly violation: GovernanceViolation }
  | { readonly kind: "select_governance_item"; readonly index: number }
  | {
      readonly kind: "set_governance_pending_action";
      readonly pendingAction: GovernancePendingAction | null;
    }
  | {
      readonly kind: "set_governance_sanction_levels";
      readonly levels: readonly GovernanceAgentSanction[];
    }
  | { readonly kind: "set_skills_list"; readonly skills: readonly DashboardSkillSummary[] }
  | { readonly kind: "set_channels_list"; readonly channels: readonly DashboardChannelSummary[] }
  | { readonly kind: "set_system_metrics"; readonly metrics: DashboardSystemMetrics }
  | { readonly kind: "scroll_domain_view"; readonly domain: string; readonly offset: number }
  | { readonly kind: "select_forge_brick"; readonly index: number }
  | { readonly kind: "toggle_agent_list_mode" }
  | { readonly kind: "set_mailbox_target"; readonly agentId: string | null }
  // ─── Delegation actions ──────────────────────────────────────────
  | {
      readonly kind: "set_delegations";
      readonly delegations: readonly import("@koi/dashboard-types").DelegationSummary[];
    }
  | { readonly kind: "set_delegation_loading"; readonly loading: boolean }
  // ─── Handoff actions ─────────────────────────────────────────────
  | {
      readonly kind: "set_handoffs";
      readonly handoffs: readonly import("@koi/dashboard-types").HandoffSummary[];
    }
  | { readonly kind: "set_handoff_loading"; readonly loading: boolean }
  // ─── Scratchpad actions ──────────────────────────────────────────
  | {
      readonly kind: "set_scratchpad_entries";
      readonly entries: readonly import("@koi/dashboard-types").ScratchpadEntrySummary[];
    }
  | {
      readonly kind: "set_scratchpad_detail";
      readonly detail: import("@koi/dashboard-types").ScratchpadEntryDetail | null;
    }
  | { readonly kind: "set_scratchpad_loading"; readonly loading: boolean }
  // ─── Mailbox actions ─────────────────────────────────────────────
  | {
      readonly kind: "set_mailbox_messages";
      readonly messages: readonly import("@koi/dashboard-types").AgentMessage[];
    }
  | { readonly kind: "set_mailbox_loading"; readonly loading: boolean }
  // ─── Nexus browser actions ───────────────────────────────────────
  | {
      readonly kind: "set_nexus_browser_entries";
      readonly entries: readonly import("@koi/dashboard-client").FsEntry[];
      readonly path: string;
    }
  | { readonly kind: "set_nexus_browser_content"; readonly content: string | null }
  | { readonly kind: "set_nexus_browser_loading"; readonly loading: boolean }
  | { readonly kind: "select_nexus_browser_entry"; readonly index: number }
  // ─── Debug view actions ─────────────────────────────────────────────
  | {
      readonly kind: "set_debug_inventory";
      readonly items: readonly import("@koi/dashboard-types").DebugInventoryItemResponse[];
    }
  | {
      readonly kind: "set_debug_contributions";
      readonly contributions: import("@koi/dashboard-types").ContributionGraphResponse | null;
    }
  | {
      readonly kind: "set_debug_trace";
      readonly trace: import("@koi/dashboard-types").DebugTurnTraceResponse | null;
    }
  | { readonly kind: "set_debug_loading"; readonly loading: boolean }
  | { readonly kind: "select_debug_turn"; readonly turnIndex: number }
  | { readonly kind: "set_debug_panel"; readonly panel: "inventory" | "waterfall" }
  | { readonly kind: "cycle_debug_visibility" }
  | { readonly kind: "highlight_debug_middleware"; readonly name: string | null };

/** Maximum messages kept in session memory (sliding window). */
export const MAX_SESSION_MESSAGES = 500;
