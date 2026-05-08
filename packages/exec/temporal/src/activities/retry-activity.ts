import type { RetryWorkflowArgs } from "../types.js";

export interface RetryActivityInput {
  readonly operation: RetryWorkflowArgs["operation"];
  readonly payload: RetryWorkflowArgs["payload"];
}

export type RetryActivityResult =
  | { readonly kind: "succeeded"; readonly value: unknown }
  | { readonly kind: "failed"; readonly error: string };

export interface RetryActivityDeps {
  readonly runOperation: (input: RetryActivityInput) => Promise<unknown>;
}

export function createRetryActivities(deps: RetryActivityDeps) {
  return {
    async runRetriedOperation(input: RetryActivityInput): Promise<RetryActivityResult> {
      try {
        const value = await deps.runOperation(input);
        return { kind: "succeeded", value } as const;
      } catch (error: unknown) {
        return { kind: "failed", error: error instanceof Error ? error.message : String(error) } as const;
      }
    },
  };
}
