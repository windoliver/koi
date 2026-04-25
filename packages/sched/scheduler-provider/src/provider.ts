import type { SchedulerComponent, Tool } from "@koi/core";
import { createCancelTool } from "./tools/cancel.js";
import { createHistoryTool } from "./tools/history.js";
import { createPauseTool } from "./tools/pause.js";
import { createQueryTool } from "./tools/query.js";
import { createResumeTool } from "./tools/resume.js";
import { createScheduleTool } from "./tools/schedule.js";
import { createStatsTool } from "./tools/stats.js";
import { createSubmitTool } from "./tools/submit.js";
import { createUnscheduleTool } from "./tools/unschedule.js";

export function createSchedulerProvider(component: SchedulerComponent): readonly Tool[] {
  return [
    createSubmitTool(component),
    createCancelTool(component),
    createScheduleTool(component),
    createUnscheduleTool(component),
    createPauseTool(component),
    createResumeTool(component),
    createQueryTool(component),
    createStatsTool(component),
    createHistoryTool(component),
  ] as const;
}
