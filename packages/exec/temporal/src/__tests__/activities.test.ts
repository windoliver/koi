import { describe, expect, test } from "bun:test";
import {
  createAgentActivities,
  createRetryActivities,
  createScheduledTaskActivities,
} from "../activities/index.js";

describe("activity factories", () => {
  test("agent activity returns updated state refs", async () => {
    const activities = createAgentActivities({
      runTurn: async () => ({
        turnId: "turn-1",
        updatedStateRefs: { lastTurnId: "turn-1", turnsProcessed: 1 },
        next: { kind: "complete" },
      }),
    });

    const result = await activities.runAgentTurn({
      agentId: "agent-1" as never,
      sessionId: "session-1" as never,
      stateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
      initialMessage: { id: "m1", senderId: "u1", content: [], timestamp: Date.now() },
    });

    expect(result.updatedStateRefs.turnsProcessed).toBe(1);
  });

  test("retry activity maps thrown errors to serializable results", async () => {
    const activities = createRetryActivities({
      runOperation: async () => {
        throw new Error("boom");
      },
    });

    const result = await activities.runRetriedOperation({ operation: "runAgentTurn", payload: {} });
    expect(result).toEqual({ kind: "failed", error: "boom" });
  });

  test("retry activity returns serializable success results", async () => {
    const serializableValue = {
      nested: { count: 2, flags: [true, false] },
      label: "ok",
    };

    const activities = createRetryActivities({
      runOperation: async () => serializableValue,
    });

    const result = await activities.runRetriedOperation({
      operation: "runScheduledTask",
      payload: {},
    });
    expect(result).toEqual({ kind: "succeeded", value: serializableValue });
    expect(result.kind === "succeeded" ? result.value : null).not.toBe(serializableValue);
  });

  test("scheduled task activity returns the built execution", async () => {
    const activities = createScheduledTaskActivities({
      dispatch: async () => undefined,
      spawn: async () => "wf-123",
    });

    await expect(
      activities.startAgentExecution({
        mode: "spawn",
        agentId: "agent-1" as never,
        stateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
        input: { kind: "text", text: "hello" },
      }),
    ).resolves.toBe("wf-123");

    await expect(
      activities.dispatchToAgent({
        mode: "dispatch",
        agentId: "agent-1" as never,
        stateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
        input: { kind: "text", text: "hello" },
      }),
    ).resolves.toBeUndefined();
  });
});
