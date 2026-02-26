/**
 * Shared test helpers for @koi/scheduler-provider tests.
 */

import type {
  Agent,
  AgentId,
  EngineInput,
  ScheduledTask,
  ScheduleId,
  SchedulerComponent,
  SchedulerStats,
  SubsystemToken,
  TaskFilter,
  TaskHistoryFilter,
  TaskId,
  TaskOptions,
  TaskRunRecord,
} from "@koi/core";
import { agentId, scheduleId, taskId } from "@koi/core";

export function createMockAgent(id = "test-agent"): Agent {
  const components = new Map<string, unknown>();
  return {
    pid: { id: agentId(id), name: "test", type: "worker", depth: 0 },
    manifest: {
      name: id,
      version: "0.0.0",
      model: { name: "test-model" },
    },
    state: "running",
    component: <T>(token: { toString: () => string }): T | undefined =>
      components.get(token.toString()) as T | undefined,
    has: (token: { toString: () => string }): boolean => components.has(token.toString()),
    hasAll: (...tokens: readonly { toString: () => string }[]): boolean =>
      tokens.every((t) => components.has(t.toString())),
    query: <T>(_prefix: string): ReadonlyMap<SubsystemToken<T>, T> => new Map(),
    components: (): ReadonlyMap<string, unknown> => components,
  };
}

export function createMockSchedulerComponent(
  pinnedAgentId: AgentId = agentId("test-agent"),
): SchedulerComponent & {
  readonly calls: readonly {
    readonly method: string;
    readonly args: readonly unknown[];
  }[];
} {
  const calls: { readonly method: string; readonly args: readonly unknown[] }[] = [];

  return {
    get calls() {
      return calls;
    },
    submit: (input: EngineInput, mode: "spawn" | "dispatch", options?: TaskOptions): TaskId => {
      calls.push({ method: "submit", args: [input, mode, options] });
      return taskId("task-1");
    },
    cancel: (id: TaskId): boolean => {
      calls.push({ method: "cancel", args: [id] });
      return true;
    },
    schedule: (
      expression: string,
      input: EngineInput,
      mode: "spawn" | "dispatch",
      options?: TaskOptions & { readonly timezone?: string | undefined },
    ): ScheduleId => {
      calls.push({ method: "schedule", args: [expression, input, mode, options] });
      return scheduleId("sch-1");
    },
    unschedule: (id: ScheduleId): boolean => {
      calls.push({ method: "unschedule", args: [id] });
      return true;
    },
    pause: (id: ScheduleId): boolean => {
      calls.push({ method: "pause", args: [id] });
      return true;
    },
    resume: (id: ScheduleId): boolean => {
      calls.push({ method: "resume", args: [id] });
      return true;
    },
    query: (_filter: TaskFilter): readonly ScheduledTask[] => {
      calls.push({ method: "query", args: [_filter] });
      return [
        {
          id: taskId("task-1"),
          agentId: pinnedAgentId,
          input: { kind: "text" as const, text: "test" },
          mode: "spawn",
          priority: 5,
          status: "pending",
          createdAt: Date.now(),
          retries: 0,
          maxRetries: 3,
        },
      ];
    },
    stats: (): SchedulerStats => {
      calls.push({ method: "stats", args: [] });
      return {
        pending: 1,
        running: 0,
        completed: 5,
        failed: 0,
        deadLettered: 0,
        activeSchedules: 2,
        pausedSchedules: 0,
      };
    },
    history: (_filter: TaskHistoryFilter): readonly TaskRunRecord[] => {
      calls.push({ method: "history", args: [_filter] });
      return [
        {
          taskId: taskId("task-1"),
          agentId: pinnedAgentId,
          status: "completed",
          startedAt: Date.now() - 1000,
          completedAt: Date.now(),
          durationMs: 1000,
          retryAttempt: 0,
        },
      ];
    },
  };
}
