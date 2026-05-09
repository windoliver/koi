import {
  startChild,
  // @ts-expect-error — uuid4 is exported at runtime from @temporalio/workflow but its
  // type declaration is dropped from index.d.ts in 1.16.x. See retry-workflow.ts for
  // the same workaround.
  uuid4 as uuid4Untyped,
} from "@temporalio/workflow";
import { createDefaultScheduledTaskActivities } from "../activities/scheduled-task-activity.js";
import type { ScheduledTaskWorkflowArgs, ScheduledTaskWorkflowResult } from "../types.js";
import { agentWorkflow } from "./agent-workflow.js";

const uuid4 = uuid4Untyped as () => string;

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
  // Replay-safe ID generation: crypto.randomUUID() is not deterministic under workflow
  // replay, but Temporal's uuid4() is. Each workflow execution sees the same sequence.
  createWorkflowId: () => `scheduled:${uuid4()}`,
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
