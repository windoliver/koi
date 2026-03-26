/**
 * Domain sub-state interfaces for TUI views.
 *
 * Each domain view has its own typed state slice with an event buffer,
 * scroll offset, and optional fetched data. TuiCapabilities tracks
 * which subsystems are available on the connected server.
 */

import type {
  AgentMessage,
  AgentProcfs,
  ChannelDashboardEvent,
  CheckpointEntry,
  ContributionGraphResponse,
  CronSchedule,
  DashboardChannelSummary,
  DashboardSkillSummary,
  DashboardSystemMetrics,
  DebugInventoryItemResponse,
  DebugTurnTraceResponse,
  DelegationSummary,
  GatewayDashboardEvent,
  GatewayTopology,
  HandoffSummary,
  HarnessDashboardEvent,
  HarnessStatus,
  MiddlewareChain,
  NexusDashboardEvent,
  ProcessTreeSnapshot,
  SchedulerDashboardEvent,
  SchedulerStats,
  SchedulerTaskSummary,
  ScratchpadEntryDetail,
  ScratchpadEntrySummary,
  SkillDashboardEvent,
  SystemDashboardEvent,
  TaskBoardSnapshot,
  TemporalDashboardEvent,
  TemporalHealth,
  WorkflowDetail,
  WorkflowSummary,
} from "@koi/dashboard-types";

// ─── Buffer limits ────────────────────────────────────────────────────

export const MAX_SKILL_EVENTS = 100;
export const MAX_CHANNEL_EVENTS = 100;
export const MAX_SYSTEM_EVENTS = 100;
export const MAX_NEXUS_EVENTS = 200;
export const MAX_GATEWAY_EVENTS = 100;
export const MAX_TEMPORAL_EVENTS = 100;
export const MAX_SCHEDULER_EVENTS = 100;
export const MAX_TASKBOARD_EVENTS = 100;
export const MAX_HARNESS_EVENTS = 100;
export const MAX_GOVERNANCE_VIOLATIONS = 200;

// ─── Domain view states ───────────────────────────────────────────────

/** Skills view — installed/removed skill events. */
export interface SkillsViewState {
  readonly events: readonly SkillDashboardEvent[];
  readonly scrollOffset: number;
  readonly skills: readonly DashboardSkillSummary[];
}

/** Channels view — connection/message events + fetched channel list. */
export interface ChannelsViewState {
  readonly events: readonly ChannelDashboardEvent[];
  readonly scrollOffset: number;
  readonly channels: readonly DashboardChannelSummary[];
}

/** System view — memory warnings, errors, activity events + metrics. */
export interface SystemViewState {
  readonly events: readonly SystemDashboardEvent[];
  readonly scrollOffset: number;
  readonly metrics: DashboardSystemMetrics | null;
}

/** Nexus view — file/namespace change events. */
export interface NexusViewState {
  readonly events: readonly NexusDashboardEvent[];
  readonly scrollOffset: number;
}

/** Gateway view — connection/topology events + fetched topology. */
export interface GatewayViewState {
  readonly events: readonly GatewayDashboardEvent[];
  readonly scrollOffset: number;
  readonly topology: GatewayTopology | null;
}

/** Temporal view — workflow lifecycle events + fetched data. */
export interface TemporalViewState {
  readonly events: readonly TemporalDashboardEvent[];
  readonly scrollOffset: number;
  readonly health: TemporalHealth | null;
  readonly workflows: readonly WorkflowSummary[];
  readonly selectedWorkflowIndex: number;
  readonly workflowDetail: WorkflowDetail | null;
}

/** Scheduler view — task/schedule events + fetched data. */
export interface SchedulerViewState {
  readonly events: readonly SchedulerDashboardEvent[];
  readonly scrollOffset: number;
  readonly stats: SchedulerStats | null;
  readonly tasks: readonly SchedulerTaskSummary[];
  readonly schedules: readonly CronSchedule[];
  readonly deadLetters: readonly import("@koi/dashboard-types").SchedulerDeadLetterEntry[];
}

/** TaskBoard view — DAG task status events + fetched snapshot. */
export interface TaskBoardViewState {
  readonly events: readonly import("@koi/dashboard-types").TaskBoardDashboardEvent[];
  readonly scrollOffset: number;
  readonly snapshot: TaskBoardSnapshot | null;
  /** Cached ASCII DAG layout — recomputed only when nodes/edges change. */
  readonly cachedLayout: readonly string[] | null;
  readonly layoutNodeCount: number;
  readonly layoutEdgeCount: number;
}

/** Harness view — checkpoint/phase events + fetched status. */
export interface HarnessViewState {
  readonly events: readonly HarnessDashboardEvent[];
  readonly scrollOffset: number;
  readonly status: HarnessStatus | null;
  readonly checkpoints: readonly CheckpointEntry[];
}

/** Per-agent sanction level entry. */
export interface GovernanceAgentSanction {
  readonly agentId: string;
  readonly level: number;
}

/** Pending confirmation for a governance action. */
/** Governance view — pending approvals + violation log. */
export interface GovernanceViewState {
  readonly pendingApprovals: readonly GovernancePendingApproval[];
  readonly violations: readonly GovernanceViolation[];
  readonly scrollOffset: number;
  readonly selectedIndex: number;
  readonly sanctionLevels: readonly GovernanceAgentSanction[];
}

/** A pending governance approval item. */
export interface GovernancePendingApproval {
  readonly id: string;
  readonly agentId: string;
  readonly action: string;
  readonly resource: string;
  readonly timestamp: number;
}

/** A governance violation log entry. */
export interface GovernanceViolation {
  readonly id: string;
  readonly agentId: string;
  readonly rule: string;
  readonly action: string;
  readonly timestamp: number;
}

/** Cost view — computed from agent metrics. */
export interface CostViewState {
  readonly scrollOffset: number;
}

/** Middleware view — fetched middleware chain for an agent. */
export interface MiddlewareViewState {
  readonly chain: MiddlewareChain | null;
  readonly scrollOffset: number;
  readonly loading: boolean;
}

/** Process tree view — fetched process tree snapshot. */
export interface ProcessTreeViewState {
  readonly snapshot: ProcessTreeSnapshot | null;
  readonly scrollOffset: number;
  readonly loading: boolean;
}

/** Agent procfs view — fetched agent runtime state. */
export interface AgentProcfsViewState {
  readonly procfs: AgentProcfs | null;
  readonly scrollOffset: number;
  readonly loading: boolean;
}

/** Delegation view — delegation grants table. */
export interface DelegationViewState {
  readonly delegations: readonly DelegationSummary[];
  readonly scrollOffset: number;
  readonly loading: boolean;
}

/** Handoff view — handoff envelopes table. */
export interface HandoffViewState {
  readonly handoffs: readonly HandoffSummary[];
  readonly scrollOffset: number;
  readonly loading: boolean;
}

/** Scratchpad view — group-scoped shared memory browser. */
export interface ScratchpadViewState {
  readonly entries: readonly ScratchpadEntrySummary[];
  readonly selectedEntry: ScratchpadEntryDetail | null;
  readonly scrollOffset: number;
  readonly loading: boolean;
  readonly currentPath: string | null;
}

/** Mailbox view — agent message inbox. */
export interface MailboxViewState {
  readonly messages: readonly AgentMessage[];
  readonly scrollOffset: number;
  readonly loading: boolean;
}

/** Nexus file browser — directory listing + content preview. */
export interface NexusBrowserState {
  readonly entries: readonly import("@koi/dashboard-client").FsEntry[];
  readonly path: string;
  readonly selectedIndex: number;
  readonly fileContent: string | null;
  readonly loading: boolean;
}

/** Visibility tier for debug span filtering. */
export type DebugVisibilityTier = "critical" | "secondary" | "all";

/** Debug view — package inventory + per-turn trace waterfall. */
export interface DebugViewState {
  readonly inventory: readonly DebugInventoryItemResponse[] | null;
  readonly contributions: ContributionGraphResponse | null;
  readonly trace: DebugTurnTraceResponse | null;
  readonly selectedTurnIndex: number;
  readonly scrollOffset: number;
  readonly loading: boolean;
  readonly activePanel: "inventory" | "waterfall";
  readonly visibilityTier: DebugVisibilityTier;
  readonly highlightedMiddleware: string | null;
}

// ─── Capabilities ─────────────────────────────────────────────────────

/** Server capabilities — which subsystems are available. */
export interface TuiCapabilities {
  readonly temporal: boolean;
  readonly scheduler: boolean;
  readonly taskboard: boolean;
  readonly harness: boolean;
  readonly forge: boolean;
  readonly gateway: boolean;
  readonly nexus: boolean;
  readonly governance: boolean;
}

// ─── Initial state factories ──────────────────────────────────────────

export function createInitialSkillsView(): SkillsViewState {
  return { events: [], scrollOffset: 0, skills: [] };
}

export function createInitialChannelsView(): ChannelsViewState {
  return { events: [], scrollOffset: 0, channels: [] };
}

export function createInitialSystemView(): SystemViewState {
  return { events: [], scrollOffset: 0, metrics: null };
}

export function createInitialNexusView(): NexusViewState {
  return { events: [], scrollOffset: 0 };
}

export function createInitialGatewayView(): GatewayViewState {
  return { events: [], scrollOffset: 0, topology: null };
}

export function createInitialTemporalView(): TemporalViewState {
  return {
    events: [],
    scrollOffset: 0,
    health: null,
    workflows: [],
    selectedWorkflowIndex: 0,
    workflowDetail: null,
  };
}

export function createInitialSchedulerView(): SchedulerViewState {
  return {
    events: [],
    scrollOffset: 0,
    stats: null,
    tasks: [],
    schedules: [],
    deadLetters: [],
  };
}

export function createInitialTaskBoardView(): TaskBoardViewState {
  return {
    events: [],
    scrollOffset: 0,
    snapshot: null,
    cachedLayout: null,
    layoutNodeCount: 0,
    layoutEdgeCount: 0,
  };
}

export function createInitialHarnessView(): HarnessViewState {
  return { events: [], scrollOffset: 0, status: null, checkpoints: [] };
}

export function createInitialGovernanceView(): GovernanceViewState {
  return {
    pendingApprovals: [],
    violations: [],
    scrollOffset: 0,
    selectedIndex: 0,
    sanctionLevels: [],
  };
}

export function createInitialCostView(): CostViewState {
  return { scrollOffset: 0 };
}

export function createInitialMiddlewareView(): MiddlewareViewState {
  return { chain: null, scrollOffset: 0, loading: false };
}

export function createInitialProcessTreeView(): ProcessTreeViewState {
  return { snapshot: null, scrollOffset: 0, loading: false };
}

export function createInitialAgentProcfsView(): AgentProcfsViewState {
  return { procfs: null, scrollOffset: 0, loading: false };
}

export function createInitialDelegationView(): DelegationViewState {
  return { delegations: [], scrollOffset: 0, loading: false };
}

export function createInitialHandoffView(): HandoffViewState {
  return { handoffs: [], scrollOffset: 0, loading: false };
}

export function createInitialScratchpadView(): ScratchpadViewState {
  return { entries: [], selectedEntry: null, scrollOffset: 0, loading: false, currentPath: null };
}

export function createInitialMailboxView(): MailboxViewState {
  return { messages: [], scrollOffset: 0, loading: false };
}

export function createInitialNexusBrowser(): NexusBrowserState {
  return { entries: [], path: "/", selectedIndex: 0, fileContent: null, loading: false };
}

export function createInitialDebugView(): DebugViewState {
  return {
    inventory: null,
    contributions: null,
    trace: null,
    selectedTurnIndex: 0,
    scrollOffset: 0,
    loading: false,
    activePanel: "inventory",
    visibilityTier: "critical",
    highlightedMiddleware: null,
  };
}
