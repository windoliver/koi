import { createDefaultAgentActivities } from "../activities/agent-activity.js";
import {
  createDefaultRetryActivities,
  type RetryActivityInput,
  type RetryActivityResult,
} from "../activities/retry-activity.js";
import type { RetryWorkflowArgs, RetryWorkflowResult } from "../types.js";
import { scheduledTaskWorkflow } from "./scheduled-task-workflow.js";

interface RetryWorkflowDeps {
  readonly runRetriedOperation: (input: RetryActivityInput) => Promise<RetryActivityResult>;
  readonly sleep: (ms: number) => Promise<void>;
}

const defaultAgentActivities = createDefaultAgentActivities();
const defaultRetryActivities = createDefaultRetryActivities({
  runAgentTurn: defaultAgentActivities.runAgentTurn,
  runScheduledTask: scheduledTaskWorkflow,
});

const defaultRetryWorkflowDeps: RetryWorkflowDeps = {
  runRetriedOperation: defaultRetryActivities.runRetriedOperation,
  sleep: async (ms) => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  },
};

let retryWorkflowDeps: RetryWorkflowDeps = defaultRetryWorkflowDeps;

export function setRetryWorkflowDepsForTest(overrides: Partial<RetryWorkflowDeps>): void {
  retryWorkflowDeps = { ...defaultRetryWorkflowDeps, ...overrides };
}

export function resetRetryWorkflowDepsForTest(): void {
  retryWorkflowDeps = defaultRetryWorkflowDeps;
}

export async function retryWorkflow(args: RetryWorkflowArgs): Promise<RetryWorkflowResult> {
  let attempts = args.attempt;

  while (attempts < args.maxAttempts) {
    attempts += 1;
    const result = await retryWorkflowDeps.runRetriedOperation({
      operation: args.operation,
      payload: args.payload,
    });

    if (result.kind === "succeeded") {
      return { kind: "succeeded", attempts, value: result.value };
    }

    if (attempts >= args.maxAttempts) {
      return { kind: "failed", attempts, error: result.error };
    }

    await retryWorkflowDeps.sleep(args.backoffMs);
  }

  return { kind: "failed", attempts, error: "retry budget exhausted" };
}
