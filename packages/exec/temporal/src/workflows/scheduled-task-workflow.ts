import { createDefaultScheduledTaskActivities } from "../activities/scheduled-task-activity.js";
import type { ScheduledTaskWorkflowArgs, ScheduledTaskWorkflowResult } from "../types.js";
import { agentWorkflow } from "./agent-workflow.js";

interface ScheduledTaskWorkflowDeps {
  readonly startAgentExecution: (input: ScheduledTaskWorkflowArgs) => Promise<string>;
  readonly dispatchToAgent: (input: ScheduledTaskWorkflowArgs) => Promise<void>;
}

const defaultScheduledTaskActivities = createDefaultScheduledTaskActivities({
  runAgentWorkflow: agentWorkflow,
});

const defaultScheduledTaskWorkflowDeps: ScheduledTaskWorkflowDeps = {
  startAgentExecution: defaultScheduledTaskActivities.startAgentExecution,
  dispatchToAgent: defaultScheduledTaskActivities.dispatchToAgent,
};

export async function scheduledTaskWorkflow(
  args: ScheduledTaskWorkflowArgs,
): Promise<ScheduledTaskWorkflowResult> {
  if (args.mode === "spawn") {
    const workflowId = await defaultScheduledTaskWorkflowDeps.startAgentExecution(args);
    return { kind: "spawned", workflowId };
  }

  await defaultScheduledTaskWorkflowDeps.dispatchToAgent(args);
  return { kind: "dispatched" };
}
