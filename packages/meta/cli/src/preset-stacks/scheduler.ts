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
import type { AgentId, Tool } from "@koi/core";
import { createSingleToolProvider, DEFAULT_SCHEDULER_CONFIG } from "@koi/core";
import { createScheduler, createSchedulerComponent, createSqliteTaskStore } from "@koi/scheduler";
import { createSchedulerProvider } from "@koi/scheduler-provider";
import type { PresetStack, StackContribution } from "../preset-stacks.js";
import { AGENT_ID_HOST_KEY } from "./execution.js";

export const schedulerStack: PresetStack = {
  id: "scheduler",
  description:
    "Task scheduling tools: scheduler_submit, scheduler_cancel, scheduler_schedule, " +
    "scheduler_unschedule, scheduler_pause, scheduler_resume, scheduler_query, " +
    "scheduler_stats, scheduler_history",
  activate: (ctx): StackContribution => {
    const agentId = (ctx.host?.[AGENT_ID_HOST_KEY] as AgentId | undefined) ?? ("tui" as AgentId);

    const db = new Database(":memory:");
    const store = createSqliteTaskStore(db);
    const scheduler = createScheduler(DEFAULT_SCHEDULER_CONFIG, store, async () => {});
    const component = createSchedulerComponent(scheduler, agentId);
    const tools = createSchedulerProvider(component);

    const providers = tools.map((tool: Tool) =>
      createSingleToolProvider({
        name: `scheduler-${tool.descriptor.name}`,
        toolName: tool.descriptor.name,
        createTool: () => tool,
      }),
    );

    return { middleware: [], providers };
  },
};
