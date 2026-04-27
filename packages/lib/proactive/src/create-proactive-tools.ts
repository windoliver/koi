/**
 * createProactiveTools — entry point factory returning all proactive tools.
 */

import type { Tool } from "@koi/core";
import { createCancelSleepTool } from "./cancel-sleep-tool.js";
import {
  createCancelScheduleTool,
  createCronToolState,
  createScheduleCronTool,
} from "./cron-tools.js";
import { createSleepTool, createSleepToolState } from "./sleep-tool.js";
import type { ProactiveToolsConfig } from "./types.js";

export function createProactiveTools(config: ProactiveToolsConfig): readonly Tool[] {
  // State maps live for the lifetime of the tool set (typically one agent
  // assembly). schedule_cron + cancel_schedule share the cron map; sleep +
  // cancel_sleep share the sleep map. See cron-tools.ts and sleep-tool.ts
  // for the idempotency semantics they enforce.
  const cronState = createCronToolState();
  const sleepState = createSleepToolState();
  return [
    createSleepTool(config, sleepState),
    createCancelSleepTool(config, sleepState),
    createScheduleCronTool(config, cronState),
    createCancelScheduleTool(config, cronState),
  ];
}
