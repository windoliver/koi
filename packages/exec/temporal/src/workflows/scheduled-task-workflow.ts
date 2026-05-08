import type { ScheduledTaskWorkflowArgs, ScheduledTaskWorkflowResult } from "../types.js";

export async function scheduledTaskWorkflow(
  args: ScheduledTaskWorkflowArgs,
): Promise<ScheduledTaskWorkflowResult> {
  return args.mode === "spawn" ? { kind: "spawned", workflowId: "pending" } : { kind: "dispatched" };
}
