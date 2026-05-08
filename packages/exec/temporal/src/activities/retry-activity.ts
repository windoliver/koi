import type { RetryWorkflowArgs } from "../types.js";

export interface RetryActivityInput {
  readonly operation: RetryWorkflowArgs["operation"];
  readonly payload: RetryWorkflowArgs["payload"];
}

export type RetryActivitySerializableValue =
  | string
  | number
  | boolean
  | null
  | readonly RetryActivitySerializableValue[]
  | { readonly [key: string]: RetryActivitySerializableValue };

export type RetryActivityResult =
  | { readonly kind: "succeeded"; readonly value: RetryActivitySerializableValue }
  | { readonly kind: "failed"; readonly error: string };

export interface RetryActivityDeps {
  readonly runOperation: (input: RetryActivityInput) => Promise<unknown>;
}

function normalizeRetryValue(value: unknown): RetryActivitySerializableValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("retry activity returned a non-serializable value");
  }

  return JSON.parse(serialized) as RetryActivitySerializableValue;
}

export function createRetryActivities(deps: RetryActivityDeps) {
  return {
    async runRetriedOperation(input: RetryActivityInput): Promise<RetryActivityResult> {
      try {
        const value = await deps.runOperation(input);
        return { kind: "succeeded", value: normalizeRetryValue(value) } as const;
      } catch (error: unknown) {
        return { kind: "failed", error: error instanceof Error ? error.message : String(error) } as const;
      }
    },
  };
}
