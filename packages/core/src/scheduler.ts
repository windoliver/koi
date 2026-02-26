/**
 * Scheduler contract — pluggable task scheduling, priority queue, cron,
 * and dead-letter queue for agent message dispatch.
 *
 * A "task" in Koi = deliver input to an agent (new or existing) at a
 * scheduled time/priority. The scheduler is a message dispatch service,
 * not arbitrary code execution.
 *
 * Exception: branded type constructors (taskId, scheduleId) are permitted
 * in L0 as zero-logic identity casts for type safety.
 * Exception: DEFAULT_SCHEDULER_CONFIG is a pure readonly data constant
 * derived from L0 type definitions.
 */

import type { AgentId } from "./ecs.js";
import type { EngineInput } from "./engine.js";
import type { KoiError } from "./errors.js";

// ---------------------------------------------------------------------------
// Branded types
// ---------------------------------------------------------------------------

declare const __taskBrand: unique symbol;

/** Branded string type for scheduled task identifiers. */
export type TaskId = string & { readonly [__taskBrand]: "TaskId" };

declare const __scheduleBrand: unique symbol;

/** Branded string type for cron schedule identifiers. */
export type ScheduleId = string & { readonly [__scheduleBrand]: "ScheduleId" };

// ---------------------------------------------------------------------------
// Branded type constructors (zero-logic casts)
// ---------------------------------------------------------------------------

/** Create a branded TaskId from a plain string. */
export function taskId(id: string): TaskId {
  return id as TaskId;
}

/** Create a branded ScheduleId from a plain string. */
export function scheduleId(id: string): ScheduleId {
  return id as ScheduleId;
}

// ---------------------------------------------------------------------------
// Task status state machine
// ---------------------------------------------------------------------------

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "dead_letter";

// ---------------------------------------------------------------------------
// Scheduled task — "deliver input to agent"
// ---------------------------------------------------------------------------

export interface ScheduledTask {
  readonly id: TaskId;
  readonly agentId: AgentId;
  readonly input: EngineInput;
  readonly mode: "spawn" | "dispatch";
  /** 0 = highest priority. */
  readonly priority: number;
  readonly status: TaskStatus;
  readonly createdAt: number;
  /** Unix timestamp ms for delayed execution. */
  readonly scheduledAt?: number | undefined;
  readonly startedAt?: number | undefined;
  readonly completedAt?: number | undefined;
  readonly retries: number;
  readonly maxRetries: number;
  /** Per-execution timeout in milliseconds. */
  readonly timeoutMs?: number | undefined;
  readonly lastError?: KoiError | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

// ---------------------------------------------------------------------------
// Submit options
// ---------------------------------------------------------------------------

export interface TaskOptions {
  /** Priority level (0 = highest). Default: 5. */
  readonly priority?: number | undefined;
  /** Defer execution by this many milliseconds. */
  readonly delayMs?: number | undefined;
  /** Maximum retry attempts. Default: 3. */
  readonly maxRetries?: number | undefined;
  /** Per-execution timeout in milliseconds. */
  readonly timeoutMs?: number | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

// ---------------------------------------------------------------------------
// Cron schedule definition
// ---------------------------------------------------------------------------

export interface CronSchedule {
  readonly id: ScheduleId;
  /** Cron expression (e.g., "0 0 * * *"). */
  readonly expression: string;
  readonly agentId: AgentId;
  readonly input: EngineInput;
  readonly mode: "spawn" | "dispatch";
  readonly taskOptions?: TaskOptions | undefined;
  readonly timezone?: string | undefined;
  readonly paused: boolean;
}

// ---------------------------------------------------------------------------
// Task run history — immutable execution records for audit
// ---------------------------------------------------------------------------

/**
 * Immutable record of a single task execution — for history/audit.
 */
export interface TaskRunRecord {
  readonly taskId: TaskId;
  readonly agentId: AgentId;
  readonly status: "completed" | "failed";
  readonly startedAt: number;
  readonly completedAt: number;
  readonly durationMs: number;
  readonly error?: string | undefined;
  readonly result?: unknown | undefined;
  readonly retryAttempt: number;
}

export interface TaskHistoryFilter {
  readonly agentId?: AgentId | undefined;
  readonly status?: "completed" | "failed" | undefined;
  readonly since?: number | undefined;
  readonly limit?: number | undefined;
}

// ---------------------------------------------------------------------------
// Task filter for queries
// ---------------------------------------------------------------------------

export interface TaskFilter {
  readonly status?: TaskStatus | undefined;
  readonly agentId?: AgentId | undefined;
  readonly priority?: number | undefined;
  readonly limit?: number | undefined;
}

// ---------------------------------------------------------------------------
// Scheduler events (discriminated union)
// ---------------------------------------------------------------------------

export type SchedulerEvent =
  | { readonly kind: "task:submitted"; readonly task: ScheduledTask }
  | { readonly kind: "task:started"; readonly taskId: TaskId }
  | { readonly kind: "task:completed"; readonly taskId: TaskId; readonly result: unknown }
  | { readonly kind: "task:failed"; readonly taskId: TaskId; readonly error: KoiError }
  | { readonly kind: "task:dead_letter"; readonly taskId: TaskId; readonly error: KoiError }
  | { readonly kind: "task:cancelled"; readonly taskId: TaskId }
  | { readonly kind: "task:recovered"; readonly taskId: TaskId; readonly retriesUsed: number }
  | { readonly kind: "schedule:created"; readonly schedule: CronSchedule }
  | { readonly kind: "schedule:removed"; readonly scheduleId: ScheduleId }
  | { readonly kind: "schedule:paused"; readonly scheduleId: ScheduleId }
  | { readonly kind: "schedule:resumed"; readonly scheduleId: ScheduleId };

// ---------------------------------------------------------------------------
// Pluggable persistence backend
// ---------------------------------------------------------------------------

export interface TaskStore extends AsyncDisposable {
  readonly save: (task: ScheduledTask) => void | Promise<void>;
  readonly load: (id: TaskId) => ScheduledTask | undefined | Promise<ScheduledTask | undefined>;
  readonly remove: (id: TaskId) => void | Promise<void>;
  readonly updateStatus: (
    id: TaskId,
    status: TaskStatus,
    patch?: Partial<Pick<ScheduledTask, "startedAt" | "completedAt" | "lastError" | "retries">>,
  ) => void | Promise<void>;
  readonly query: (
    filter: TaskFilter,
  ) => readonly ScheduledTask[] | Promise<readonly ScheduledTask[]>;
  readonly loadPending: () => readonly ScheduledTask[] | Promise<readonly ScheduledTask[]>;
}

// ---------------------------------------------------------------------------
// Main scheduler contract
// ---------------------------------------------------------------------------

export interface TaskScheduler extends AsyncDisposable {
  readonly submit: (
    agentId: AgentId,
    input: EngineInput,
    mode: "spawn" | "dispatch",
    options?: TaskOptions,
  ) => TaskId | Promise<TaskId>;
  readonly cancel: (id: TaskId) => boolean | Promise<boolean>;
  readonly schedule: (
    expression: string,
    agentId: AgentId,
    input: EngineInput,
    mode: "spawn" | "dispatch",
    options?: TaskOptions & { readonly timezone?: string | undefined },
  ) => ScheduleId | Promise<ScheduleId>;
  readonly unschedule: (id: ScheduleId) => boolean | Promise<boolean>;
  readonly pause: (id: ScheduleId) => boolean | Promise<boolean>;
  readonly resume: (id: ScheduleId) => boolean | Promise<boolean>;
  readonly query: (
    filter: TaskFilter,
  ) => readonly ScheduledTask[] | Promise<readonly ScheduledTask[]>;
  readonly stats: () => SchedulerStats;
  readonly history: (
    filter: TaskHistoryFilter,
  ) => readonly TaskRunRecord[] | Promise<readonly TaskRunRecord[]>;
  readonly watch: (listener: (event: SchedulerEvent) => void) => () => void;
}

// ---------------------------------------------------------------------------
// Agent-facing component (exposed via SCHEDULER token)
// ---------------------------------------------------------------------------

/**
 * Agent-facing subset of TaskScheduler — exposed via SCHEDULER component token.
 *
 * Unlike TaskScheduler, this interface:
 * - Omits agentId from submit/schedule (pinned by provider)
 * - Omits watch (streaming not suitable for tool calls)
 * - Omits AsyncDisposable (infrastructure lifecycle, not agent concern)
 */
export interface SchedulerComponent {
  readonly submit: (
    input: EngineInput,
    mode: "spawn" | "dispatch",
    options?: TaskOptions,
  ) => TaskId | Promise<TaskId>;
  readonly cancel: (id: TaskId) => boolean | Promise<boolean>;
  readonly schedule: (
    expression: string,
    input: EngineInput,
    mode: "spawn" | "dispatch",
    options?: TaskOptions & { readonly timezone?: string | undefined },
  ) => ScheduleId | Promise<ScheduleId>;
  readonly unschedule: (id: ScheduleId) => boolean | Promise<boolean>;
  readonly pause: (id: ScheduleId) => boolean | Promise<boolean>;
  readonly resume: (id: ScheduleId) => boolean | Promise<boolean>;
  readonly query: (
    filter: TaskFilter,
  ) => readonly ScheduledTask[] | Promise<readonly ScheduledTask[]>;
  readonly stats: () => SchedulerStats | Promise<SchedulerStats>;
  readonly history: (
    filter: TaskHistoryFilter,
  ) => readonly TaskRunRecord[] | Promise<readonly TaskRunRecord[]>;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export interface SchedulerStats {
  readonly pending: number;
  readonly running: number;
  readonly completed: number;
  readonly failed: number;
  readonly deadLettered: number;
  readonly activeSchedules: number;
  readonly pausedSchedules: number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SchedulerConfig {
  readonly maxConcurrent: number;
  readonly defaultPriority: number;
  readonly defaultMaxRetries: number;
  readonly baseRetryDelayMs: number;
  readonly maxRetryDelayMs: number;
  readonly retryJitterMs: number;
  readonly pollIntervalMs: number;
  /** Threshold (ms) after which a "running" task is considered stale and eligible for recovery. */
  readonly staleTaskThresholdMs: number;
}

/** Default scheduler configuration. */
export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = Object.freeze({
  maxConcurrent: 10,
  defaultPriority: 5,
  defaultMaxRetries: 3,
  baseRetryDelayMs: 1_000,
  maxRetryDelayMs: 60_000,
  retryJitterMs: 500,
  pollIntervalMs: 1_000,
  staleTaskThresholdMs: 300_000,
});

// ---------------------------------------------------------------------------
// Pluggable schedule persistence (opt-in, separate from TaskStore)
// ---------------------------------------------------------------------------

/** Persistence backend for cron schedule definitions. */
export interface ScheduleStore extends AsyncDisposable {
  readonly saveSchedule: (schedule: CronSchedule) => void | Promise<void>;
  readonly removeSchedule: (id: ScheduleId) => void | Promise<void>;
  readonly loadSchedules: () => readonly CronSchedule[] | Promise<readonly CronSchedule[]>;
}
