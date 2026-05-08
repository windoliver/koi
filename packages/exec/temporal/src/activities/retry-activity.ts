import type {
  AgentWorkflowConfig,
  RetryWorkflowArgs,
  ScheduledTaskWorkflowArgs,
  ScheduledTaskWorkflowResult,
} from "../types.js";
import type { AgentTurnResult } from "./agent-activity.js";

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

export interface DefaultRetryActivityDeps {
  readonly runAgentTurn: (input: AgentWorkflowConfig) => Promise<AgentTurnResult>;
  readonly runScheduledTask: (
    input: ScheduledTaskWorkflowArgs,
  ) => Promise<ScheduledTaskWorkflowResult>;
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
        return {
          kind: "failed",
          error: error instanceof Error ? error.message : String(error),
        } as const;
      }
    },
  };
}

export function createDefaultRetryActivities(deps: DefaultRetryActivityDeps) {
  return createRetryActivities({
    async runOperation(input: RetryActivityInput): Promise<unknown> {
      switch (input.operation) {
        case "runAgentTurn":
          return deps.runAgentTurn(input.payload as unknown as AgentWorkflowConfig);
        case "runScheduledTask":
          return deps.runScheduledTask(input.payload as unknown as ScheduledTaskWorkflowArgs);
      }
    },
  });
}
