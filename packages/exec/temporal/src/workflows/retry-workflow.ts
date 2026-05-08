import type { RetryWorkflowArgs, RetryWorkflowResult } from "../types.js";

export async function retryWorkflow(args: RetryWorkflowArgs): Promise<RetryWorkflowResult> {
  return { kind: "failed", attempts: args.attempt + 1, error: "unimplemented" };
}
