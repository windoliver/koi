import type { ScheduledInputPayload, ScheduledTaskWorkflowArgs } from "../types.js";

export interface ScheduledTaskActivityDeps {
  readonly buildExecution: (input: ScheduledTaskWorkflowArgs) => Promise<{
    readonly mode: "spawn" | "dispatch";
    readonly input: ScheduledInputPayload;
  }>;
}

export function createScheduledTaskActivities(deps: ScheduledTaskActivityDeps) {
  return {
    async runScheduledTask(input: ScheduledTaskWorkflowArgs) {
      return deps.buildExecution(input);
    },
  };
}
