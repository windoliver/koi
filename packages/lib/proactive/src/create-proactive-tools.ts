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
import { createSleepTool } from "./sleep-tool.js";
import type { ProactiveToolsConfig } from "./types.js";

export function createProactiveTools(config: ProactiveToolsConfig): readonly Tool[] {
  // Cron idempotency state is shared between schedule_cron (writes) and
  // cancel_schedule (clears entries on successful unschedule). The map lives
  // for the lifetime of the tool set — typically one agent assembly.
  const cronState = createCronToolState();
  return [
    createSleepTool(config),
    createCancelSleepTool(config),
    createScheduleCronTool(config, cronState),
    createCancelScheduleTool(config, cronState),
  ];
}
