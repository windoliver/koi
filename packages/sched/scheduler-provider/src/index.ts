/**
 * @koi/scheduler-provider — Agent-facing scheduler tools (Layer 2)
 *
 * Provides a ComponentProvider that wraps a TaskScheduler as Tool
 * components with pinned agentId. Agents can submit tasks, create
 * cron schedules, query status, and view stats — all scoped to their
 * own identity.
 *
 * Depends on @koi/core only — never on L1 or peer L2 packages.
 */

// types — re-exported from @koi/core for convenience
export type {
  ScheduledTask,
  ScheduleId,
  SchedulerComponent,
  SchedulerStats,
  TaskFilter,
  TaskHistoryFilter,
  TaskId,
  TaskOptions,
  TaskRunRecord,
  TaskScheduler,
} from "@koi/core";

// domain-specific types
export type { SchedulerOperation } from "./constants.js";

// constants
export {
  DEFAULT_HISTORY_DEFAULT,
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_PREFIX,
  DEFAULT_QUERY_DEFAULT,
  DEFAULT_QUERY_LIMIT,
  OPERATIONS,
} from "./constants.js";
// registration (ToolRegistration pattern)
export { createSchedulerRegistration } from "./registration.js";
// provider
export type { SchedulerProviderConfig } from "./scheduler-component-provider.js";
export { createSchedulerProvider } from "./scheduler-component-provider.js";
// skill
export { SCHEDULER_SKILL, SCHEDULER_SKILL_CONTENT, SCHEDULER_SKILL_NAME } from "./skill.js";

// tool factories — for advanced usage (custom tool composition)
export { createCancelTool } from "./tools/cancel.js";
export { createHistoryTool } from "./tools/history.js";
export { createPauseTool } from "./tools/pause.js";
export { createQueryTool } from "./tools/query.js";
export { createResumeTool } from "./tools/resume.js";
export { createScheduleTool } from "./tools/schedule.js";
export { createStatsTool } from "./tools/stats.js";
export { createSubmitTool } from "./tools/submit.js";
export { createUnscheduleTool } from "./tools/unschedule.js";
