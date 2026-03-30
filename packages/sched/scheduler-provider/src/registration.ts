/**
 * ToolRegistration for @koi/scheduler-provider — self-describing registration descriptor.
 *
 * Exports a factory that creates a ToolRegistration given a SchedulerProviderConfig.
 * The registration uses a WeakMap to cache one SchedulerComponent per agent,
 * ensuring all 9 tool factories share the same ownership-tracking component.
 *
 * Usage in a manifest:
 *   tools:
 *     - name: scheduler_submit
 *       package: "@koi/scheduler-provider"
 */

import type {
  Agent,
  AgentId,
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
  ToolRegistration,
} from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import type { SchedulerOperation } from "./constants.js";
import {
  DEFAULT_HISTORY_DEFAULT,
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_PREFIX,
  DEFAULT_QUERY_DEFAULT,
  DEFAULT_QUERY_LIMIT,
  OPERATIONS,
} from "./constants.js";
import type { SchedulerProviderConfig } from "./scheduler-component-provider.js";
import { createCancelTool } from "./tools/cancel.js";
import { createHistoryTool } from "./tools/history.js";
import { createPauseTool } from "./tools/pause.js";
import { createQueryTool } from "./tools/query.js";
import { createResumeTool } from "./tools/resume.js";
import { createScheduleTool } from "./tools/schedule.js";
import { createStatsTool } from "./tools/stats.js";
import { createSubmitTool } from "./tools/submit.js";
import { createUnscheduleTool } from "./tools/unschedule.js";

// ---------------------------------------------------------------------------
// Per-agent component creation (mirrors scheduler-component-provider logic)
// ---------------------------------------------------------------------------

/**
 * Creates a SchedulerComponent wrapping a TaskScheduler with a pinned agentId.
 * Ownership enforcement: submit/schedule pin agentId, query/history inject it,
 * cancel verifies via query, unschedule/pause/resume track local ScheduleIds.
 */
function createSchedulerComponentForAgent(
  scheduler: TaskScheduler,
  pinnedAgentId: AgentId,
): SchedulerComponent {
  const ownedScheduleIds = new Set<ScheduleId>();

  return {
    submit: (
      input: EngineInput,
      mode: "spawn" | "dispatch",
      options?: TaskOptions,
    ): TaskId | Promise<TaskId> => scheduler.submit(pinnedAgentId, input, mode, options),

    cancel: async (id: TaskId): Promise<boolean> => {
      const tasks = await scheduler.query({ agentId: pinnedAgentId });
      if (!tasks.some((t) => t.id === id)) return false;
      return scheduler.cancel(id);
    },

    schedule: async (
      expression: string,
      input: EngineInput,
      mode: "spawn" | "dispatch",
      options?: TaskOptions & { readonly timezone?: string | undefined },
    ): Promise<ScheduleId> => {
      const id = await scheduler.schedule(expression, pinnedAgentId, input, mode, options);
      ownedScheduleIds.add(id);
      return id;
    },

    unschedule: async (id: ScheduleId): Promise<boolean> => {
      if (!ownedScheduleIds.has(id)) return false;
      const result = await scheduler.unschedule(id);
      if (result) {
        ownedScheduleIds.delete(id);
      }
      return result;
    },

    pause: (id: ScheduleId): boolean | Promise<boolean> => {
      if (!ownedScheduleIds.has(id)) return false;
      return scheduler.pause(id);
    },

    resume: (id: ScheduleId): boolean | Promise<boolean> => {
      if (!ownedScheduleIds.has(id)) return false;
      return scheduler.resume(id);
    },

    query: (filter: TaskFilter) => scheduler.query({ ...filter, agentId: pinnedAgentId }),

    stats: () => scheduler.stats(),

    history: (filter: TaskHistoryFilter) =>
      scheduler.history({ ...filter, agentId: pinnedAgentId }),
  };
}

// ---------------------------------------------------------------------------
// Tool creation dispatch (maps SchedulerOperation -> Tool)
// ---------------------------------------------------------------------------

type InternalToolFactory = (
  component: SchedulerComponent,
  prefix: string,
  policy: ToolPolicy,
  queryLimit?: number,
  queryDefault?: number,
  historyLimit?: number,
  historyDefault?: number,
) => Tool;

const TOOL_FACTORIES: Readonly<Record<SchedulerOperation, InternalToolFactory>> = {
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a ToolRegistration for scheduler tools.
 *
 * Call this with a SchedulerProviderConfig and export the result as `registration`.
 * A WeakMap caches one SchedulerComponent per Agent so all tool factories
 * created for the same agent share a single ownership-tracking component.
 */
export function createSchedulerRegistration(config: SchedulerProviderConfig): ToolRegistration {
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

  // Cache one SchedulerComponent per agent so all tools share ownership tracking.
  const componentCache = new WeakMap<Agent, SchedulerComponent>();

  function getOrCreateComponent(agent: Agent): SchedulerComponent {
    const cached = componentCache.get(agent);
    if (cached !== undefined) return cached;
    const component = createSchedulerComponentForAgent(scheduler, agent.pid.id);
    componentCache.set(agent, component);
    return component;
  }

  return {
    name: "scheduler",
    tools: operations.map((op) => ({
      name: `${prefix}_${op}`,
      create: (agent: Agent): Tool => {
        const component = getOrCreateComponent(agent);
        return TOOL_FACTORIES[op](
          component,
          prefix,
          policy,
          queryLimit,
          queryDefault,
          historyLimit,
          historyDefault,
        );
      },
    })),
  };
}
