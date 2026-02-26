/**
 * Constants for @koi/scheduler-provider — tool names and defaults.
 */

/** Default tool name prefix for scheduler tools. */
export const DEFAULT_PREFIX = "scheduler" as const;

/** All scheduler operation names. */
export const OPERATIONS = [
  "submit",
  "cancel",
  "schedule",
  "unschedule",
  "query",
  "stats",
  "pause",
  "resume",
  "history",
] as const;

export type SchedulerOperation = (typeof OPERATIONS)[number];

/** Maximum results from query tool. */
export const DEFAULT_QUERY_LIMIT = 50;

/** Default results from query tool when limit not specified. */
export const DEFAULT_QUERY_DEFAULT = 20;

/** Maximum results from history tool. */
export const DEFAULT_HISTORY_LIMIT = 50;

/** Default results from history tool when limit not specified. */
export const DEFAULT_HISTORY_DEFAULT = 20;
