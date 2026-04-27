/**
 * createProactiveTools — entry point factory returning all proactive tools.
 */

import type { Tool } from "@koi/core";
import { createCancelScheduleTool, createScheduleCronTool } from "./cron-tools.js";
import { createSleepTool } from "./sleep-tool.js";
import type { ProactiveToolsConfig } from "./types.js";

export function createProactiveTools(config: ProactiveToolsConfig): readonly Tool[] {
  return [
    createSleepTool(config),
    createScheduleCronTool(config),
    createCancelScheduleTool(config),
  ];
}
