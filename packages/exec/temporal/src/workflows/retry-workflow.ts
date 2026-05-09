import {
  startChild,
  // @ts-expect-error — workflowInfo is exported at runtime from @temporalio/workflow but
  // its type declaration is dropped from index.d.ts in 1.16.x (export * from './workflow' is
  // present, yet only a subset of names surface to callers). Type the result locally instead.
  workflowInfo as workflowInfoUntyped,
  sleep as workflowSleep,
} from "@temporalio/workflow";

const workflowInfo = workflowInfoUntyped as () => { readonly workflowId: string };

import { createDefaultAgentActivities } from "../activities/agent-activity.js";
import {
  createDefaultRetryActivities,
  type RetryActivityInput,
  type RetryActivityResult,
  type RetryActivitySerializableValue,
} from "../activities/retry-activity.js";
import type {
  RetryWorkflowArgs,
  RetryWorkflowResult,
  ScheduledTaskWorkflowArgs,
  ScheduledTaskWorkflowResult,
} from "../types.js";
import { scheduledTaskWorkflow } from "./scheduled-task-workflow.js";

interface ChildRetryConfig {
  readonly maximumAttempts: number;
  readonly initialIntervalMs: number;
}

interface RetryWorkflowDeps {
  readonly runRetriedOperation: (input: RetryActivityInput) => Promise<RetryActivityResult>;
  readonly runScheduledTaskChild: (
    input: ScheduledTaskWorkflowArgs,
    retry: ChildRetryConfig,
  ) => Promise<ScheduledTaskWorkflowResult>;
  readonly sleep: (ms: number) => Promise<void>;
}

const defaultAgentActivities = createDefaultAgentActivities();
const defaultRetryActivities = createDefaultRetryActivities({
  runAgentTurn: defaultAgentActivities.runAgentTurn,
});

function deriveChildWorkflowId(): string {
  // Stable per-parent child ID: the parent's workflowId is unique across the Temporal
  // namespace, so this collides with no other retry workflow's child. We deliberately do
  // NOT include the attempt counter — runScheduledTask is single-shot from the parent's
  // view (see runOnce). One stable child per parent retry execution prevents the
  // duplicate-execution hazard that per-attempt IDs would create after a partial failure.
  return `${workflowInfo().workflowId}:scheduled-task`;
}

const defaultRetryWorkflowDeps: RetryWorkflowDeps = {
  runRetriedOperation: defaultRetryActivities.runRetriedOperation,
  // scheduledTaskWorkflow uses workflow-context APIs (startChild). Invoke it as a child
  // workflow rather than through an activity so the underlying APIs run in the correct context.
  runScheduledTaskChild: async (input, retry) => {
    // Explicit child retry policy: the parent loop is single-shot for runScheduledTask
    // (side-effect-bearing), so the caller's RetryWorkflowArgs.maxAttempts/backoffMs
    // are threaded into the child boundary where Temporal can retry without duplicating
    // the parent's already-committed startChild side effect.
    // backoffCoefficient: 1 preserves the fixed-interval contract that retryWorkflow's
    // sleep loop uses for the activity-based path; runScheduledTask must match.
    const handle = await startChild(scheduledTaskWorkflow, {
      args: [input],
      workflowId: deriveChildWorkflowId(),
      retry: {
        initialInterval: `${retry.initialIntervalMs}ms`,
        backoffCoefficient: 1,
        maximumAttempts: retry.maximumAttempts,
      },
    });
    return (handle as { readonly result: () => Promise<ScheduledTaskWorkflowResult> }).result();
  },
  sleep: workflowSleep,
};

let retryWorkflowDeps: RetryWorkflowDeps = defaultRetryWorkflowDeps;

export function setRetryWorkflowDepsForTest(overrides: Partial<RetryWorkflowDeps>): void {
  retryWorkflowDeps = { ...defaultRetryWorkflowDeps, ...overrides };
}

export function resetRetryWorkflowDepsForTest(): void {
  retryWorkflowDeps = defaultRetryWorkflowDeps;
}

// Temporal control-flow failures must propagate — they signal external lifecycle decisions
// (operator cancel, workflow termination), not application errors that retry should mask.
// Walk the `cause` chain because child-workflow waits surface cancellation through
// ChildWorkflowFailure wrappers; the underlying CancelledFailure may be nested.
function isTemporalControlFlowFailure(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      if (current.name === "CancelledFailure" || current.name === "TerminatedFailure") {
        return true;
      }
      current = (current as { cause?: unknown }).cause;
      continue;
    }
    return false;
  }
  return false;
}

async function runOnce(args: RetryWorkflowArgs): Promise<RetryActivityResult> {
  if (args.operation === "runScheduledTask") {
    // runScheduledTask side effects (spawn agent, dispatch signal) are not safely
    // re-executable, so the parent retry loop short-circuits after the first attempt
    // (see retryWorkflow). Internal transient failures are absorbed by the child's
    // RetryPolicy, which honors the caller's maxAttempts/backoffMs budget.
    try {
      // Subtract prior parent attempts from the child budget so a resumed call with
      // args.attempt > 0 doesn't grant the child the full original budget on top of work
      // the parent already accounted for.
      const remainingBudget = Math.max(args.maxAttempts - args.attempt, 1);
      const value = await retryWorkflowDeps.runScheduledTaskChild(
        args.payload as unknown as ScheduledTaskWorkflowArgs,
        {
          maximumAttempts: remainingBudget,
          initialIntervalMs: args.backoffMs,
        },
      );
      return { kind: "succeeded", value: value as unknown as RetryActivitySerializableValue };
    } catch (error: unknown) {
      if (isTemporalControlFlowFailure(error)) {
        throw error;
      }
      return {
        kind: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return retryWorkflowDeps.runRetriedOperation({
    operation: args.operation,
    payload: args.payload,
  });
}

export async function retryWorkflow(args: RetryWorkflowArgs): Promise<RetryWorkflowResult> {
  let attempts = args.attempt;

  while (attempts < args.maxAttempts) {
    attempts += 1;
    const result = await runOnce(args);

    if (result.kind === "succeeded") {
      return { kind: "succeeded", attempts, value: result.value };
    }

    // runScheduledTask is single-shot at the parent boundary (child has its own retry
    // policy). Surface the original child failure immediately rather than sleeping
    // through synthetic retries that can never succeed. Report attempts as the full
    // configured budget — the child consumed up to maxAttempts internally before the
    // failure surfaced — so observers see real execution count, not the single parent
    // call that delegated retries downward.
    if (args.operation === "runScheduledTask") {
      return { kind: "failed", attempts: args.maxAttempts, error: result.error };
    }

    if (attempts >= args.maxAttempts) {
      return { kind: "failed", attempts, error: result.error };
    }

    await retryWorkflowDeps.sleep(args.backoffMs);
  }

  return { kind: "failed", attempts, error: "retry budget exhausted" };
}
