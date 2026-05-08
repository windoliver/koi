import { describe, expect, test } from "bun:test";
import type {
  AgentWorkflowConfig,
  RetryWorkflowArgs,
  RetryWorkflowResult,
  ScheduledTaskWorkflowArgs,
  ScheduledTaskWorkflowResult,
} from "../index.js";
import * as temporal from "../index.js";

describe("temporal workflow public surface", () => {
  test("exports Koi-owned workflow type names", () => {
    expect(typeof temporal.DEFAULT_TEMPORAL_CONFIG).toBe("object");
  });

  test("workflow argument shapes are structurally usable without SDK imports", () => {
    const agentConfig: AgentWorkflowConfig = {
      agentId: "agent-1" as AgentWorkflowConfig["agentId"],
      sessionId: "session-1" as AgentWorkflowConfig["sessionId"],
      stateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
    };
    const scheduled: ScheduledTaskWorkflowArgs = {
      mode: "dispatch",
      agentId: agentConfig.agentId,
      stateRefs: agentConfig.stateRefs,
      input: { kind: "text", text: "hello" },
    };
    const retryArgs: RetryWorkflowArgs = {
      operation: "runAgentTurn",
      attempt: 0,
      maxAttempts: 3,
      backoffMs: 250,
      payload: { agentId: agentConfig.agentId },
    };
    const scheduledResult: ScheduledTaskWorkflowResult = { kind: "dispatched" };
    const retryResult: RetryWorkflowResult = { kind: "succeeded", attempts: 1, value: {} };

    expect(scheduled.mode).toBe("dispatch");
    expect(retryArgs.maxAttempts).toBe(3);
    expect(scheduledResult.kind).toBe("dispatched");
    expect(retryResult.kind).toBe("succeeded");
  });
});
