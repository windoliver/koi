import { startChild } from "@temporalio/workflow";
import { createDefaultScheduledTaskActivities } from "../activities/scheduled-task-activity.js";
import type { ScheduledTaskWorkflowArgs, ScheduledTaskWorkflowResult } from "../types.js";
import { agentWorkflow } from "./agent-workflow.js";

interface ScheduledTaskWorkflowDeps {
  readonly startAgentExecution: (input: ScheduledTaskWorkflowArgs) => Promise<string>;
  readonly dispatchToAgent: (input: ScheduledTaskWorkflowArgs) => Promise<void>;
}

const defaultScheduledTaskActivities = createDefaultScheduledTaskActivities({
  runAgentWorkflow: agentWorkflow,
  spawnAgentWorkflow: async (workflowId, config) => {
    await startChild(agentWorkflow, {
      args: [config],
      workflowId,
    });
  },
});

const defaultScheduledTaskWorkflowDeps: ScheduledTaskWorkflowDeps = {
  startAgentExecution: defaultScheduledTaskActivities.startAgentExecution,
  dispatchToAgent: defaultScheduledTaskActivities.dispatchToAgent,
};

let scheduledTaskWorkflowDeps: ScheduledTaskWorkflowDeps = defaultScheduledTaskWorkflowDeps;

export function setScheduledTaskWorkflowDepsForTest(
  overrides: Partial<ScheduledTaskWorkflowDeps>,
): void {
  scheduledTaskWorkflowDeps = { ...defaultScheduledTaskWorkflowDeps, ...overrides };
}

export function resetScheduledTaskWorkflowDepsForTest(): void {
  scheduledTaskWorkflowDeps = defaultScheduledTaskWorkflowDeps;
}

export async function scheduledTaskWorkflow(
  args: ScheduledTaskWorkflowArgs,
): Promise<ScheduledTaskWorkflowResult> {
  if (args.mode === "spawn") {
    const workflowId = await scheduledTaskWorkflowDeps.startAgentExecution(args);
    return { kind: "spawned", workflowId };
  }

  await scheduledTaskWorkflowDeps.dispatchToAgent(args);
  return { kind: "dispatched" };
}
