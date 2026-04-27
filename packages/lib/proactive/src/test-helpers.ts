/**
 * Test helpers — minimal SchedulerComponent stub.
 *
 * Records every call so tests can assert on argument shape and order without
 * spinning up a real scheduler. Returns deterministic IDs derived from a
 * monotonically incrementing counter.
 */

import type {
  EngineInput,
  ScheduleId,
  SchedulerComponent,
  SchedulerStats,
  TaskId,
  TaskOptions,
} from "@koi/core";
import { scheduleId, taskId } from "@koi/core";

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
      return taskId(`task-${counter}`);
    },
    cancel(id): boolean {
      cancelCalls.push(id);
      return options.cancelResult ?? true;
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
    query(): readonly never[] {
      return [];
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
  };
}
