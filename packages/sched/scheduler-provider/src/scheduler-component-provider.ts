/**
 * Scheduler ComponentProvider — attaches scheduler Tool components to an agent.
 *
 * Wraps a TaskScheduler into a SchedulerComponent with pinned agentId,
 * then exposes 9 tools for agent interaction. The agentId is captured at
 * attach() time — agents can only schedule/cancel their own tasks.
 */

import type {
  Agent,
  AgentId,
  ComponentProvider,
  EngineInput,
  ScheduleId,
  SchedulerComponent,
  TaskFilter,
  TaskHistoryFilter,
  TaskId,
  TaskOptions,
  TaskScheduler,
  Tool,
  ToolPolicy,
} from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY, SCHEDULER, skillToken, toolToken } from "@koi/core";
import type { SchedulerOperation } from "./constants.js";
import {
  DEFAULT_HISTORY_DEFAULT,
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_PREFIX,
  DEFAULT_QUERY_DEFAULT,
  DEFAULT_QUERY_LIMIT,
  OPERATIONS,
} from "./constants.js";
import { SCHEDULER_SKILL, SCHEDULER_SKILL_NAME } from "./skill.js";
import { createCancelTool } from "./tools/cancel.js";
import { createHistoryTool } from "./tools/history.js";
import { createPauseTool } from "./tools/pause.js";
import { createQueryTool } from "./tools/query.js";
import { createResumeTool } from "./tools/resume.js";
import { createScheduleTool } from "./tools/schedule.js";
import { createStatsTool } from "./tools/stats.js";
import { createSubmitTool } from "./tools/submit.js";
import { createUnscheduleTool } from "./tools/unschedule.js";

export interface SchedulerProviderConfig {
  readonly scheduler: TaskScheduler;
  readonly policy?: ToolPolicy;
  readonly prefix?: string;
  readonly operations?: readonly SchedulerOperation[];
  /** Max results from query tool. Default: 50. */
  readonly queryLimit?: number;
  /** Default results from query tool when limit not specified. Default: 20. */
  readonly queryDefault?: number;
  /** Max results from history tool. Default: 50. */
  readonly historyLimit?: number;
  /** Default results from history tool when limit not specified. Default: 20. */
  readonly historyDefault?: number;
}

/**
 * Creates a SchedulerComponent that wraps TaskScheduler with a pinned agentId.
 * The agentId is captured from the agent at attach() time.
 */
function createSchedulerComponentForAgent(
  scheduler: TaskScheduler,
  pinnedAgentId: AgentId,
): SchedulerComponent {
  return {
    submit: (
      input: EngineInput,
      mode: "spawn" | "dispatch",
      options?: TaskOptions,
    ): TaskId | Promise<TaskId> => scheduler.submit(pinnedAgentId, input, mode, options),

    cancel: (id: TaskId): boolean | Promise<boolean> => scheduler.cancel(id),

    schedule: (
      expression: string,
      input: EngineInput,
      mode: "spawn" | "dispatch",
      options?: TaskOptions & { readonly timezone?: string | undefined },
    ): ScheduleId | Promise<ScheduleId> =>
      scheduler.schedule(expression, pinnedAgentId, input, mode, options),

    unschedule: (id: ScheduleId): boolean | Promise<boolean> => scheduler.unschedule(id),

    pause: (id: ScheduleId): boolean | Promise<boolean> => scheduler.pause(id),

    resume: (id: ScheduleId): boolean | Promise<boolean> => scheduler.resume(id),

    query: (filter: TaskFilter) => scheduler.query({ ...filter, agentId: pinnedAgentId }),

    stats: () => scheduler.stats(),

    history: (filter: TaskHistoryFilter) =>
      scheduler.history({ ...filter, agentId: pinnedAgentId }),
  };
}

type ToolFactory = (
  component: SchedulerComponent,
  prefix: string,
  policy: ToolPolicy,
  queryLimit?: number,
  queryDefault?: number,
  historyLimit?: number,
  historyDefault?: number,
) => Tool;

const TOOL_FACTORIES: Readonly<Record<SchedulerOperation, ToolFactory>> = {
  submit: (c, p, t) => createSubmitTool(c, p, t),
  cancel: (c, p, t) => createCancelTool(c, p, t),
  schedule: (c, p, t) => createScheduleTool(c, p, t),
  unschedule: (c, p, t) => createUnscheduleTool(c, p, t),
  query: (c, p, t, ql, qd) => createQueryTool(c, p, t, ql, qd),
  stats: (c, p, t) => createStatsTool(c, p, t),
  pause: (c, p, t) => createPauseTool(c, p, t),
  resume: (c, p, t) => createResumeTool(c, p, t),
  history: (c, p, t, _ql, _qd, hl, hd) => createHistoryTool(c, p, t, hl, hd),
};

export function createSchedulerProvider(config: SchedulerProviderConfig): ComponentProvider {
  const {
    scheduler,
    policy = DEFAULT_UNSANDBOXED_POLICY,
    prefix = DEFAULT_PREFIX,
    operations = OPERATIONS,
    queryLimit = DEFAULT_QUERY_LIMIT,
    queryDefault = DEFAULT_QUERY_DEFAULT,
    historyLimit = DEFAULT_HISTORY_LIMIT,
    historyDefault = DEFAULT_HISTORY_DEFAULT,
  } = config;

  return {
    name: "scheduler",

    attach: async (agent: Agent): Promise<ReadonlyMap<string, unknown>> => {
      const component = createSchedulerComponentForAgent(scheduler, agent.pid.id);

      const toolEntries = operations.map((op) => {
        const factory = TOOL_FACTORIES[op];
        const tool = factory(
          component,
          prefix,
          policy,
          queryLimit,
          queryDefault,
          historyLimit,
          historyDefault,
        );
        return [toolToken(tool.descriptor.name) as string, tool] as const;
      });

      return new Map<string, unknown>([
        [SCHEDULER as string, component],
        ...toolEntries,
        [skillToken(SCHEDULER_SKILL_NAME) as string, SCHEDULER_SKILL],
      ]);
    },

    detach: async (_agent: Agent): Promise<void> => {
      // Scheduler lifecycle managed externally — no-op
    },
  };
}
