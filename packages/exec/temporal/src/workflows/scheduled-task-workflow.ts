import type { ScheduledTaskWorkflowArgs, ScheduledTaskWorkflowResult } from "../types.js";

interface ScheduledTaskWorkflowDeps {
  readonly startAgentExecution: (input: ScheduledTaskWorkflowArgs) => Promise<string>;
  readonly dispatchToAgent: (input: ScheduledTaskWorkflowArgs) => Promise<void>;
}

const defaultScheduledTaskWorkflowDeps: ScheduledTaskWorkflowDeps = {
  startAgentExecution: async (input) =>
    `${String(input.agentId)}:${input.stateRefs.turnsProcessed + 1}`,
  dispatchToAgent: async () => undefined,
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
