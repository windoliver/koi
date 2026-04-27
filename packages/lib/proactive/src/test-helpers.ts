/**
 * Test helpers — minimal SchedulerComponent stub.
 *
 * Records every call so tests can assert on argument shape and order without
 * spinning up a real scheduler. Returns deterministic IDs derived from a
 * monotonically incrementing counter.
 */

import type {
  EngineInput,
  ScheduledTask,
  ScheduleId,
  SchedulerComponent,
  SchedulerStats,
  TaskId,
  TaskOptions,
} from "@koi/core";
import { agentId as agentIdBrand, scheduleId, taskId } from "@koi/core";

export interface SubmitCall {
  readonly input: EngineInput;
  readonly mode: "spawn" | "dispatch";
  readonly options: TaskOptions | undefined;
}

export interface ScheduleCall {
  readonly expression: string;
  readonly input: EngineInput;
  readonly mode: "spawn" | "dispatch";
  readonly options: (TaskOptions & { readonly timezone?: string | undefined }) | undefined;
}

export interface SchedulerStub {
  readonly component: SchedulerComponent;
  readonly submitCalls: readonly SubmitCall[];
  readonly scheduleCalls: readonly ScheduleCall[];
  readonly unscheduleCalls: readonly ScheduleId[];
  readonly cancelCalls: readonly TaskId[];
  /** Mark a previously-submitted task as no longer live (simulates completion/purge). */
  readonly retireTask: (id: TaskId | string) => void;
  /** True iff the stub is currently reporting `id` as a live task. */
  readonly isLive: (id: TaskId | string) => boolean;
}

export interface SchedulerStubOptions {
  /** When provided, scheduler.submit throws this error. */
  readonly submitError?: Error;
  /** When provided, scheduler.schedule throws this error. */
  readonly scheduleError?: Error;
  /** Boolean returned by unschedule. Defaults to true. */
  readonly unscheduleResult?: boolean;
  /** Boolean returned by cancel. Defaults to true. */
  readonly cancelResult?: boolean;
}

export function createSchedulerStub(options: SchedulerStubOptions = {}): SchedulerStub {
  // let justified: counter for deterministic ID generation across calls
  let counter = 0;
  const submitCalls: SubmitCall[] = [];
  const scheduleCalls: ScheduleCall[] = [];
  const unscheduleCalls: ScheduleId[] = [];
  const cancelCalls: TaskId[] = [];
  // Tasks the stub is currently reporting as live. Submit adds, cancel
  // and retireTask remove. query() reads from this set.
  const liveTaskIds = new Set<string>();
  const stubAgentId = agentIdBrand("stub-agent");

  const stats: SchedulerStats = {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    deadLettered: 0,
    activeSchedules: 0,
    pausedSchedules: 0,
  };

  const component: SchedulerComponent = {
    submit(input, mode, opts): TaskId {
      if (options.submitError !== undefined) {
        throw options.submitError;
      }
      submitCalls.push({ input, mode, options: opts });
      counter += 1;
      const id = taskId(`task-${counter}`);
      liveTaskIds.add(id as string);
      return id;
    },
    cancel(id): boolean {
      cancelCalls.push(id);
      const removed = options.cancelResult ?? true;
      if (removed) liveTaskIds.delete(id as string);
      return removed;
    },
    schedule(expression, input, mode, opts): ScheduleId {
      if (options.scheduleError !== undefined) {
        throw options.scheduleError;
      }
      scheduleCalls.push({ expression, input, mode, options: opts });
      counter += 1;
      return scheduleId(`sched-${counter}`);
    },
    unschedule(id): boolean {
      unscheduleCalls.push(id);
      return options.unscheduleResult ?? true;
    },
    pause(): boolean {
      return true;
    },
    resume(): boolean {
      return true;
    },
    query(): readonly ScheduledTask[] {
      const out: ScheduledTask[] = [];
      for (const id of liveTaskIds) {
        out.push({
          id: taskId(id),
          agentId: stubAgentId,
          input: { kind: "text", text: "" },
          mode: "spawn",
          priority: 0,
          status: "pending",
          createdAt: 0,
          retries: 0,
          maxRetries: 0,
        });
      }
      return out;
    },
    stats(): SchedulerStats {
      return stats;
    },
    history(): readonly never[] {
      return [];
    },
  };

  return {
    component,
    get submitCalls(): readonly SubmitCall[] {
      return submitCalls;
    },
    get scheduleCalls(): readonly ScheduleCall[] {
      return scheduleCalls;
    },
    get unscheduleCalls(): readonly ScheduleId[] {
      return unscheduleCalls;
    },
    get cancelCalls(): readonly TaskId[] {
      return cancelCalls;
    },
    retireTask(id: TaskId | string): void {
      liveTaskIds.delete(id as string);
    },
    isLive(id: TaskId | string): boolean {
      return liveTaskIds.has(id as string);
    },
  };
}
