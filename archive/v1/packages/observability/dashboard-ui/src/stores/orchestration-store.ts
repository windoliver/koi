/**
 * Zustand store for orchestration state — Temporal, Scheduler, Task Board, Harness.
 *
 * Updated via SSE events (domain-scoped dispatchers) and REST fetches.
 */

import type {
  CheckpointEntry,
  CronSchedule,
  HarnessStatus,
  SchedulerDeadLetterEntry,
  SchedulerStats,
  SchedulerTaskSummary,
  TaskBoardSnapshot,
  TemporalHealth,
  WorkflowSummary,
} from "@koi/dashboard-types";
import { create } from "zustand";

interface OrchestrationState {
  // Temporal
  readonly temporalHealth: TemporalHealth | null;
  readonly workflows: readonly WorkflowSummary[];

  // Scheduler
  readonly schedulerStats: SchedulerStats | null;
  readonly schedulerTasks: readonly SchedulerTaskSummary[];
  readonly schedules: readonly CronSchedule[];
  readonly schedulerDlq: readonly SchedulerDeadLetterEntry[];

  // Task Board
  readonly taskBoardSnapshot: TaskBoardSnapshot | null;

  // Harness
  readonly harnessStatus: HarnessStatus | null;
  readonly checkpoints: readonly CheckpointEntry[];

  // Command capabilities (from health endpoint)
  readonly commandsDetail: {
    readonly pauseHarness: boolean;
    readonly resumeHarness: boolean;
    readonly retryDlq: boolean;
    readonly pauseSchedule: boolean;
    readonly resumeSchedule: boolean;
    readonly deleteSchedule: boolean;
  } | null;

  // Invalidation (SSE-driven refetch signal)
  readonly lastInvalidatedAt: number;

  // Actions
  readonly setCommandsDetail: (detail: OrchestrationState["commandsDetail"]) => void;
  readonly setTemporalHealth: (health: TemporalHealth) => void;
  readonly setWorkflows: (workflows: readonly WorkflowSummary[]) => void;
  readonly setSchedulerStats: (stats: SchedulerStats) => void;
  readonly setSchedulerTasks: (tasks: readonly SchedulerTaskSummary[]) => void;
  readonly setSchedules: (schedules: readonly CronSchedule[]) => void;
  readonly setSchedulerDlq: (entries: readonly SchedulerDeadLetterEntry[]) => void;
  readonly setTaskBoardSnapshot: (snapshot: TaskBoardSnapshot) => void;
  readonly setHarnessStatus: (status: HarnessStatus) => void;
  readonly setCheckpoints: (checkpoints: readonly CheckpointEntry[]) => void;
  readonly invalidate: () => void;
}

export const useOrchestrationStore = create<OrchestrationState>((set) => ({
  temporalHealth: null,
  workflows: [],
  schedulerStats: null,
  schedulerTasks: [],
  schedules: [],
  schedulerDlq: [],
  taskBoardSnapshot: null,
  harnessStatus: null,
  checkpoints: [],
  commandsDetail: null,
  lastInvalidatedAt: 0,

  setCommandsDetail: (detail) => set({ commandsDetail: detail }),
  setTemporalHealth: (health) => set({ temporalHealth: health }),
  setWorkflows: (workflows) => set({ workflows }),
  setSchedulerStats: (stats) => set({ schedulerStats: stats }),
  setSchedulerTasks: (tasks) => set({ schedulerTasks: tasks }),
  setSchedules: (schedules) => set({ schedules }),
  setSchedulerDlq: (entries) => set({ schedulerDlq: entries }),
  setTaskBoardSnapshot: (snapshot) => set({ taskBoardSnapshot: snapshot }),
  setHarnessStatus: (status) => set({ harnessStatus: status }),
  setCheckpoints: (checkpoints) => set({ checkpoints }),
  invalidate: () => set({ lastInvalidatedAt: Date.now() }),
}));
