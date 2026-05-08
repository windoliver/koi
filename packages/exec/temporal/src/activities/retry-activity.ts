import type { RetryWorkflowResult } from "../types.js";

export interface RetryActivityDeps {
  readonly runOperation: (input: { readonly operation: string; readonly payload: unknown }) => Promise<unknown>;
}

export function createRetryActivities(deps: RetryActivityDeps) {
  return {
    async runRetriedOperation(input: { readonly operation: string; readonly payload: unknown }) {
      try {
        const value = await deps.runOperation(input);
        return { kind: "succeeded", attempts: 1, value } as const satisfies RetryWorkflowResult;
      } catch (error: unknown) {
        return {
          kind: "failed",
          attempts: 1,
          error: error instanceof Error ? error.message : String(error),
        } as const satisfies RetryWorkflowResult;
      }
    },
  };
}
