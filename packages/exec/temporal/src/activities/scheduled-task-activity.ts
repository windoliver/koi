import type { ScheduledTaskWorkflowArgs } from "../types.js";

export interface ScheduledTaskActivityDeps {
  readonly spawn: (input: ScheduledTaskWorkflowArgs) => Promise<string>;
  readonly dispatch: (input: ScheduledTaskWorkflowArgs) => Promise<void>;
}

export function createScheduledTaskActivities(deps: ScheduledTaskActivityDeps) {
  return {
    async startAgentExecution(input: ScheduledTaskWorkflowArgs) {
      return deps.spawn(input);
    },
    async dispatchToAgent(input: ScheduledTaskWorkflowArgs) {
      await deps.dispatch(input);
    },
  };
}
