/**
 * RuntimeViewDataSource — computed state views for the admin panel.
 *
 * These are read-only projections of engine/gateway state that are
 * NOT file-backed. Surfaced via GET /api/view/* endpoints.
 *
 * All methods return `T | Promise<T>` so implementations can be
 * sync (in-memory engine registry) or async (remote query).
 */

import type { AgentId, KoiError, ProcessState, Result } from "@koi/core";
import type { ForgeDashboardEvent } from "./events.js";

// ---------------------------------------------------------------------------
// Process tree — recursive agent hierarchy
// ---------------------------------------------------------------------------

export interface ProcessTreeNode {
  readonly agentId: AgentId;
  readonly name: string;
  readonly state: ProcessState;
  readonly agentType: "copilot" | "worker";
  readonly depth: number;
  readonly children: readonly ProcessTreeNode[];
}

export interface ProcessTreeSnapshot {
  readonly roots: readonly ProcessTreeNode[];
  readonly totalAgents: number;
  readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// Agent procfs — runtime state snapshot (like /proc/PID/status)
// ---------------------------------------------------------------------------

export interface AgentProcfs {
  readonly agentId: AgentId;
  readonly name: string;
  readonly state: ProcessState;
  readonly agentType: "copilot" | "worker";
  readonly model?: string;
  readonly channels: readonly string[];
  readonly turns: number;
  readonly tokenCount: number;
  readonly startedAt: number;
  readonly lastActivityAt: number;
  readonly parentId?: AgentId;
  readonly childCount: number;
  readonly tools?: readonly { readonly name: string; readonly origin: string }[] | undefined;
  readonly skills?: readonly { readonly name: string; readonly source: string }[] | undefined;
}

// ---------------------------------------------------------------------------
// Middleware chain — ordered middleware for an agent
// ---------------------------------------------------------------------------

export interface MiddlewareEntry {
  readonly name: string;
  readonly phase: "intercept" | "observe" | "resolve";
  readonly enabled: boolean;
  /** Middleware priority within its phase tier (lower = outer onion layer). */
  readonly priority?: number | undefined;
  /** Which hooks this middleware implements (e.g., ["wrapModelCall", "wrapToolCall"]). */
  readonly hooks?: readonly string[] | undefined;
  /** Whether this middleware runs concurrently in the observe phase. */
  readonly concurrent?: boolean | undefined;
  /** How this middleware was injected: static (manifest), forged, or dynamic. */
  readonly source?: "static" | "forged" | "dynamic" | undefined;
}

export interface MiddlewareChain {
  readonly agentId: AgentId;
  readonly entries: readonly MiddlewareEntry[];
}

// ---------------------------------------------------------------------------
// Gateway topology — connected channels and nodes
// ---------------------------------------------------------------------------

export interface GatewayConnection {
  readonly channelId: string;
  readonly channelType: string;
  readonly agentId: AgentId;
  readonly connected: boolean;
  readonly connectedAt: number;
}

export interface GatewayTopology {
  readonly connections: readonly GatewayConnection[];
  readonly nodeCount: number;
  readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// System metrics (re-exported from data-source for convenience)
// ---------------------------------------------------------------------------

export type { DashboardSystemMetrics } from "./data-source.js";

// ---------------------------------------------------------------------------
// Temporal views (Phase 2)
// ---------------------------------------------------------------------------

export interface WorkflowSummary {
  readonly workflowId: string;
  readonly workflowType: string;
  readonly status: "running" | "completed" | "failed" | "cancelled" | "terminated" | "timed_out";
  readonly startTime: number;
  readonly closeTime?: number;
  readonly taskQueue: string;
  /** Whether this workflow is a copilot or worker agent. */
  readonly entityType?: "copilot" | "worker";
  /** How many times this workflow has restarted via Continue-As-New (when available). */
  readonly canCount?: number;
}

export interface WorkflowDetail extends WorkflowSummary {
  readonly runId: string;
  readonly searchAttributes: Readonly<Record<string, unknown>>;
  readonly memo: Readonly<Record<string, unknown>>;
  readonly pendingActivities: number;
  /** Number of pending (unprocessed) signals queued for this workflow. */
  readonly pendingSignals: number;
  /** How many times this workflow has restarted via Continue-As-New. */
  readonly canCount: number;
  /** Lightweight state references from the workflow's query handler. */
  readonly stateRefs?: WorkflowStateRefs;
  /** Server-backed event timeline from Temporal workflow history. */
  readonly timeline?: readonly TimelineEvent[];
}

/** A single event in the workflow timeline, derived from Temporal history. */
export interface TimelineEvent {
  readonly time: number;
  readonly label: string;
  readonly category: "lifecycle" | "activity" | "signal" | "timer" | "error";
}

/** Agent state references exposed via workflow query. */
export interface WorkflowStateRefs {
  readonly lastTurnId?: string;
  readonly turnsProcessed: number;
  /** Activity status from the getStatus query (idle/working/shutting_down). */
  readonly activityStatus?: string;
}

export interface TemporalHealth {
  readonly healthy: boolean;
  readonly serverAddress: string;
  readonly namespace: string;
  readonly latencyMs?: number;
}

// ---------------------------------------------------------------------------
// Scheduler views (Phase 2)
// ---------------------------------------------------------------------------

export interface SchedulerTaskSummary {
  readonly taskId: string;
  readonly agentId: string;
  readonly status: "pending" | "running" | "completed" | "failed" | "dead_letter";
  readonly priority: number;
  readonly submittedAt: number;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly retryCount: number;
}

export interface SchedulerStats {
  readonly submitted: number;
  readonly completed: number;
  readonly failed: number;
  readonly deadLetterCount: number;
  readonly concurrencyLimit?: number | undefined;
  readonly currentConcurrency: number;
}

export interface CronSchedule {
  readonly scheduleId: string;
  readonly pattern: string;
  readonly nextFireTime?: number | undefined;
  readonly active: boolean;
  readonly description?: string;
}

export interface SchedulerDeadLetterEntry {
  readonly entryId: string;
  readonly taskId: string;
  readonly failedAt: number;
  readonly error: string;
  readonly retryCount: number;
}

// ---------------------------------------------------------------------------
// Task board views (Phase 2)
// ---------------------------------------------------------------------------

export interface TaskBoardNode {
  readonly taskId: string;
  readonly label: string;
  readonly status: "pending" | "running" | "completed" | "failed";
  readonly assignedTo?: string;
  readonly result?: unknown;
  readonly error?: string;
}

export interface TaskBoardEdge {
  readonly from: string;
  readonly to: string;
}

export interface TaskBoardSnapshot {
  readonly nodes: readonly TaskBoardNode[];
  readonly edges: readonly TaskBoardEdge[];
  readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// Harness views (Phase 2)
// ---------------------------------------------------------------------------

export interface HarnessStatus {
  readonly phase: "idle" | "running" | "paused" | "completed" | "failed";
  readonly sessionCount: number;
  readonly taskProgress: { readonly completed: number; readonly total: number };
  readonly tokenUsage: { readonly used: number; readonly budget: number };
  readonly autoResumeEnabled: boolean;
  readonly startedAt?: number;
}

export interface CheckpointEntry {
  readonly id: string;
  readonly type: "soft" | "hard";
  readonly createdAt: number;
  readonly sessionId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Forge views (self-improvement observability)
// ---------------------------------------------------------------------------

export interface ForgeBrickView {
  readonly brickId: string;
  readonly name: string;
  readonly status: "active" | "deprecated" | "promoted" | "quarantined";
  readonly fitness: number;
  readonly sampleCount: number;
  readonly createdAt: number;
  readonly lastUpdatedAt: number;
}

export interface ForgeStats {
  readonly totalBricks: number;
  readonly activeBricks: number;
  readonly demandSignals: number;
  readonly crystallizeCandidates: number;
  readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// Debug views (instrumentation)
// ---------------------------------------------------------------------------

export interface DebugSpanResponse {
  readonly name: string;
  readonly hook: string;
  readonly durationMs: number;
  readonly source: string;
  readonly phase: string;
  readonly priority: number;
  readonly nextCalled: boolean;
  readonly error?: string | undefined;
  readonly children?: readonly DebugSpanResponse[] | undefined;
  readonly tier?: string | undefined;
}

export interface ResolverSpanResponse {
  readonly toolId: string;
  readonly source: string;
  readonly durationMs: number;
}

export interface ChannelIOSpanResponse {
  readonly direction: string;
  readonly kind: string;
  readonly durationMs: number;
}

export interface ForgeRefreshSpanResponse {
  readonly descriptorsChanged: boolean;
  readonly descriptorCount: number;
  readonly middlewareRecomposed: boolean;
  readonly timestamp: number;
}

export interface DebugTurnTraceResponse {
  readonly turnIndex: number;
  readonly totalDurationMs: number;
  readonly spans: readonly DebugSpanResponse[];
  readonly timestamp: number;
  readonly resolverSpans?: readonly ResolverSpanResponse[] | undefined;
  readonly channelSpans?: readonly ChannelIOSpanResponse[] | undefined;
  readonly forgeSpans?: readonly ForgeRefreshSpanResponse[] | undefined;
}

export interface DebugInventoryItemResponse {
  readonly name: string;
  readonly category: string;
  readonly enabled: boolean;
  readonly source: string;
  readonly hooks?: readonly string[] | undefined;
  readonly phase?: string | undefined;
  readonly priority?: number | undefined;
  readonly concurrent?: boolean | undefined;
  readonly lastUsedTurn?: number | undefined;
}

export interface DebugInventoryResponse {
  readonly agentId: string;
  readonly items: readonly DebugInventoryItemResponse[];
  readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// Data source interface
// ---------------------------------------------------------------------------

export interface RuntimeViewDataSource {
  readonly getProcessTree: () => ProcessTreeSnapshot | Promise<ProcessTreeSnapshot>;

  readonly getAgentProcfs: (
    agentId: AgentId,
  ) => AgentProcfs | undefined | Promise<AgentProcfs | undefined>;

  readonly getMiddlewareChain: (agentId: AgentId) => MiddlewareChain | Promise<MiddlewareChain>;

  readonly getGatewayTopology: () => GatewayTopology | Promise<GatewayTopology>;

  // Phase 2: Orchestration views (optional — UI hides tabs when absent)

  readonly temporal?: {
    readonly getHealth: () => TemporalHealth | Promise<TemporalHealth>;
    readonly listWorkflows: () => Promise<readonly WorkflowSummary[]>;
    readonly getWorkflow: (id: string) => Promise<Result<WorkflowDetail | undefined, KoiError>>;
  };

  readonly scheduler?: {
    readonly listTasks: () => Promise<readonly SchedulerTaskSummary[]>;
    readonly getStats: () => SchedulerStats | Promise<SchedulerStats>;
    readonly listSchedules: () => Promise<readonly CronSchedule[]>;
    readonly listDeadLetters: () => Promise<readonly SchedulerDeadLetterEntry[]>;
  };

  readonly taskBoard?: {
    readonly getSnapshot: () => TaskBoardSnapshot | Promise<TaskBoardSnapshot>;
  };

  readonly harness?: {
    readonly getStatus: () => HarnessStatus | Promise<HarnessStatus>;
    readonly getCheckpoints: () => Promise<readonly CheckpointEntry[]>;
  };

  readonly forge?: {
    readonly listBricks: () => Promise<readonly ForgeBrickView[]>;
    readonly getStats: () => ForgeStats | Promise<ForgeStats>;
    readonly listRecentEvents: () => Promise<readonly ForgeDashboardEvent[]>;
  };

  readonly debug?:
    | {
        readonly getInventory: (
          agentId: AgentId,
        ) => DebugInventoryResponse | Promise<DebugInventoryResponse>;
        readonly getTrace: (
          agentId: AgentId,
          turnIndex: number,
        ) => DebugTurnTraceResponse | undefined | Promise<DebugTurnTraceResponse | undefined>;
      }
    | undefined;
}
