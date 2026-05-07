/**
 * Scheduler preset stack — in-process task scheduling tools.
 *
 * Contributes 9 providers from @koi/scheduler-provider:
 *   scheduler_submit, scheduler_cancel, scheduler_schedule,
 *   scheduler_unschedule, scheduler_pause, scheduler_resume,
 *   scheduler_query, scheduler_stats, scheduler_history
 *
 * Wires an in-memory SQLite scheduler scoped to the active agentId.
 */

import { Database } from "bun:sqlite";
import type { AgentId, ScheduleStore, TaskStore, Tool } from "@koi/core";
import { createSingleToolProvider, DEFAULT_SCHEDULER_CONFIG } from "@koi/core";
import {
  createScheduler,
  createSchedulerComponent,
  createSqliteScheduleStore,
  createSqliteTaskStore,
} from "@koi/scheduler";
import {
  createNexusSchedulerBackends,
  type NexusSchedulerConfig,
  validateNexusSchedulerConfig,
} from "@koi/scheduler-nexus";
import { createSchedulerProvider } from "@koi/scheduler-provider";
import type { PresetStack, StackContribution } from "../preset-stacks.js";
import { migrateLocalSchedulerToNexus } from "./scheduler-migration.js";

const AGENT_ID_HOST_KEY = "agentId";

export const SCHEDULER_NEXUS_HOST_KEY = "schedulerNexus";
export const SCHEDULER_LOCAL_TASK_STORE_HOST_KEY = "schedulerLocalTaskStore";
export const SCHEDULER_LOCAL_SCHEDULE_STORE_HOST_KEY = "schedulerLocalScheduleStore";

type SchedulerBackend =
  | { readonly kind: "local" }
  | { readonly kind: "nexus"; readonly config: NexusSchedulerConfig };

function createDefaultLocalStores(): {
  readonly taskStore: TaskStore;
  readonly scheduleStore: ScheduleStore;
} {
  const db = new Database(":memory:");
  return {
    taskStore: createSqliteTaskStore(db),
    scheduleStore: createSqliteScheduleStore(db),
  };
}

function readHostStore<T>(
  ctx: { readonly host?: Readonly<Record<string, unknown>> | undefined },
  key: string,
): T | undefined {
  return ctx.host?.[key] as T | undefined;
}

function buildProviders(agentId: AgentId, scheduler: ReturnType<typeof createScheduler>) {
  const component = createSchedulerComponent(scheduler, agentId);
  const tools = createSchedulerProvider(component);

  return tools.map((tool: Tool) =>
    createSingleToolProvider({
      name: `scheduler-${tool.descriptor.name}`,
      toolName: tool.descriptor.name,
      createTool: () => tool,
    }),
  );
}

export function resolveSchedulerBackend(ctx: {
  readonly host?: Readonly<Record<string, unknown>> | undefined;
}): SchedulerBackend {
  const parsed = validateNexusSchedulerConfig(ctx.host?.[SCHEDULER_NEXUS_HOST_KEY]);
  if (!parsed.ok) {
    return { kind: "local" };
  }
  return { kind: "nexus", config: parsed.value };
}

export const schedulerStack: PresetStack = {
  id: "scheduler",
  description:
    "Task scheduling tools: scheduler_submit, scheduler_cancel, scheduler_schedule, " +
    "scheduler_unschedule, scheduler_pause, scheduler_resume, scheduler_query, " +
    "scheduler_stats, scheduler_history",
  activate: async (ctx): Promise<StackContribution> => {
    const agentId = (ctx.host?.[AGENT_ID_HOST_KEY] as AgentId | undefined) ?? ("tui" as AgentId);
    const defaults = createDefaultLocalStores();
    const localTaskStore =
      readHostStore<TaskStore>(ctx, SCHEDULER_LOCAL_TASK_STORE_HOST_KEY) ?? defaults.taskStore;
    const localScheduleStore =
      readHostStore<ScheduleStore>(ctx, SCHEDULER_LOCAL_SCHEDULE_STORE_HOST_KEY) ??
      defaults.scheduleStore;
    const backend = resolveSchedulerBackend(ctx);

    if (backend.kind === "nexus") {
      const { taskStore, scheduleStore, queueBackend } = createNexusSchedulerBackends(
        backend.config,
      );
      await migrateLocalSchedulerToNexus({
        localTaskStore,
        localScheduleStore,
        nexusTaskStore: taskStore,
        nexusScheduleStore: scheduleStore,
        nexusQueueBackend: queueBackend,
      });

      const scheduler = createScheduler(
        DEFAULT_SCHEDULER_CONFIG,
        taskStore,
        async () => {},
        undefined,
        scheduleStore,
        {
          queueBackend,
          nodeId: ctx.hostId ?? "scheduler",
        },
      );
      return { middleware: [], providers: buildProviders(agentId, scheduler) };
    }

    const scheduler = createScheduler(
      DEFAULT_SCHEDULER_CONFIG,
      localTaskStore,
      async () => {},
      undefined,
      localScheduleStore,
    );
    return { middleware: [], providers: buildProviders(agentId, scheduler) };
  },
};
