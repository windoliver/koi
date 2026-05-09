import type { AgentWorkflowConfig, RetryWorkflowArgs } from "../types.js";
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
}

function normalizeRetryValue(value: unknown): RetryActivitySerializableValue {
  if (value === null) {
    return null;
  }

  if (value === undefined) {
    return null;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeRetryValue(entry));
  }

  if (typeof value !== "object") {
    throw new Error("retry activity returned a non-serializable value");
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("retry activity returned a non-serializable value");
  }

  const normalized: Record<string, RetryActivitySerializableValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    normalized[key] = normalizeRetryValue(entry);
  }

  return normalized;
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

export function createDefaultRetryActivities(
  deps: DefaultRetryActivityDeps,
): ReturnType<typeof createRetryActivities> {
  return createRetryActivities({
    async runOperation(input: RetryActivityInput): Promise<unknown> {
      if (input.operation === "runAgentTurn") {
        return deps.runAgentTurn(input.payload as unknown as AgentWorkflowConfig);
      }
      // runScheduledTask invokes @temporalio/workflow APIs (startChild) and is therefore
      // unsafe from activity context. retryWorkflow handles that operation as a child
      // workflow directly.
      throw new Error(
        `retry-activity cannot execute workflow operation '${input.operation}' from activity context`,
      );
    },
  });
}
