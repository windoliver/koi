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
}

// ---------------------------------------------------------------------------
// Middleware chain — ordered middleware for an agent
// ---------------------------------------------------------------------------

export interface MiddlewareEntry {
  readonly name: string;
  readonly phase: "intercept" | "observe" | "resolve";
  readonly enabled: boolean;
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
}

export interface WorkflowDetail extends WorkflowSummary {
  readonly runId: string;
  readonly searchAttributes: Readonly<Record<string, unknown>>;
  readonly memo: Readonly<Record<string, unknown>>;
  readonly pendingActivities: number;
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
  readonly concurrencyLimit: number;
  readonly currentConcurrency: number;
}

export interface CronSchedule {
  readonly scheduleId: string;
  readonly pattern: string;
  readonly nextFireTime: number;
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
}
