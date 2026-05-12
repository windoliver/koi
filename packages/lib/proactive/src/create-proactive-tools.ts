/**
 * createProactiveTools — entry point factory returning all proactive tools.
 */

import type { Tool } from "@koi/core";
import { createCancelSleepTool } from "./cancel-sleep-tool.js";
import {
  type CronToolState,
  createCancelScheduleTool,
  createCronToolState,
  createScheduleCronTool,
} from "./cron-tools.js";
import {
  createCancelMonitorTool,
  createCreateMonitorTool,
  createListMonitorsTool,
  createMonitorToolState,
  createUpdateMonitorTool,
  type MonitorToolState,
} from "./monitor-tools.js";
import { createNotifyTool } from "./notify-tool.js";
import { createSleepTool, createSleepToolState, type SleepToolState } from "./sleep-tool.js";
import type { ProactiveToolsConfig } from "./types.js";

export const PROACTIVE_TOOL_NAMES = [
  "sleep",
  "cancel_sleep",
  "schedule_cron",
  "cancel_schedule",
  "create_monitor",
  "list_monitors",
  "update_monitor",
  "cancel_monitor",
  "notify",
] as const;

export interface ProactiveToolStates {
  readonly sleepState: SleepToolState;
  readonly cronState: CronToolState;
  readonly monitorState: MonitorToolState;
}

export function assembleProactiveTools(
  config: ProactiveToolsConfig,
  states: ProactiveToolStates,
): readonly Tool[] {
  const { sleepState, cronState, monitorState } = states;
  const { resolveChannel } = config;
  return [
    createSleepTool(config, sleepState),
    createCancelSleepTool(config, sleepState),
    createScheduleCronTool(config, cronState),
    createCancelScheduleTool(config, cronState),
    createCreateMonitorTool(config, monitorState),
    createListMonitorsTool(monitorState),
    createUpdateMonitorTool(config, monitorState),
    createCancelMonitorTool(config, monitorState),
    ...(resolveChannel !== undefined
      ? [
          createNotifyTool({
            resolveChannel,
            names: () => config.channelNames?.() ?? [],
          }),
        ]
      : []),
  ];
}

export function createProactiveTools(config: ProactiveToolsConfig): readonly Tool[] {
  // State maps live for the lifetime of the tool set (typically one agent
  // assembly). schedule_cron + cancel_schedule share the cron map; sleep +
  // cancel_sleep share the sleep map. See cron-tools.ts and sleep-tool.ts
  // for the idempotency semantics they enforce. Monitor tools share a
  // process-local state map for create/list/update/cancel.
  return assembleProactiveTools(config, {
    sleepState: createSleepToolState(),
    cronState: createCronToolState(),
    monitorState: createMonitorToolState(),
  });
}
