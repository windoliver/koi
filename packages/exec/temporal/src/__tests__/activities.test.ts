import { describe, expect, test } from "bun:test";
import {
  createAgentActivities,
  createDefaultAgentActivities,
} from "../activities/agent-activity.js";
import {
  createDefaultRetryActivities,
  createRetryActivities,
} from "../activities/retry-activity.js";
import {
  createDefaultScheduledTaskActivities,
  createScheduledTaskActivities,
} from "../activities/scheduled-task-activity.js";

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

  test("default agent activity advances message-backed state and requests another turn when messages remain", async () => {
    const activities = createDefaultAgentActivities();

    const result = await activities.runAgentTurn({
      agentId: "agent-1" as never,
      sessionId: "session-1" as never,
      stateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
      initialMessages: [
        { id: "m1", senderId: "u1", content: [{ kind: "text", text: "first" }], timestamp: 1 },
        { id: "m2", senderId: "u1", content: [{ kind: "text", text: "second" }], timestamp: 2 },
      ],
    });

    expect(result).toEqual({
      turnId: "m1",
      updatedStateRefs: { lastTurnId: "m1", turnsProcessed: 1 },
      next: { kind: "retry" },
    });
  });

  test("default agent activity completes immediately when there are no pending messages", async () => {
    const activities = createDefaultAgentActivities();

    await expect(
      activities.runAgentTurn({
        agentId: "agent-1" as never,
        sessionId: "session-1" as never,
        stateRefs: { lastTurnId: "turn-9", turnsProcessed: 9 },
      }),
    ).resolves.toEqual({
      turnId: "turn-9",
      updatedStateRefs: { lastTurnId: "turn-9", turnsProcessed: 9 },
      next: { kind: "complete" },
    });
  });

  test("default agent activity completes when the current batch has already been consumed", async () => {
    const activities = createDefaultAgentActivities();

    await expect(
      activities.runAgentTurn({
        agentId: "agent-1" as never,
        sessionId: "session-1" as never,
        stateRefs: { lastTurnId: "m1", turnsProcessed: 1 },
        initialMessages: [
          { id: "m1", senderId: "u1", content: [{ kind: "text", text: "only" }], timestamp: 1 },
        ],
      }),
    ).resolves.toEqual({
      turnId: "m1",
      updatedStateRefs: { lastTurnId: "m1", turnsProcessed: 1 },
      next: { kind: "complete" },
    });
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

  test("retry activity preserves undefined fields when cloning success payloads", async () => {
    const activities = createRetryActivities({
      runOperation: async () => ({
        updatedStateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
      }),
    });

    const result = await activities.runRetriedOperation({
      operation: "runAgentTurn",
      payload: {},
    });

    expect(result).toEqual({
      kind: "succeeded",
      value: { updatedStateRefs: { lastTurnId: undefined, turnsProcessed: 0 } },
    });
  });

  test("default retry activity routes scheduled task operations through the scheduled-task handler", async () => {
    const activities = createDefaultRetryActivities({
      runAgentTurn: async () => ({
        turnId: "turn-1",
        updatedStateRefs: { lastTurnId: "turn-1", turnsProcessed: 1 },
        next: { kind: "complete" },
      }),
      runScheduledTask: async () => ({ kind: "spawned", workflowId: "wf-123" }),
    });

    const result = await activities.runRetriedOperation({
      operation: "runScheduledTask",
      payload: {
        mode: "spawn",
        agentId: "agent-1",
        stateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
        input: { kind: "text", text: "tick" },
      },
    });

    expect(result).toEqual({
      kind: "succeeded",
      value: { kind: "spawned", workflowId: "wf-123" },
    });
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

  test("default scheduled task activity materializes scheduled input into an agent workflow config", async () => {
    const seenConfigs: unknown[] = [];
    const activities = createDefaultScheduledTaskActivities({
      createWorkflowId: () => "scheduled:agent-1:run-1",
      runAgentWorkflow: async () => undefined,
      spawnAgentWorkflow: async (_workflowId, config) => {
        seenConfigs.push(config);
      },
    });

    const workflowIdPromise = activities.startAgentExecution({
      mode: "spawn",
      agentId: "agent-1" as never,
      stateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
      input: { kind: "text", text: "hello" },
    });
    await expect(workflowIdPromise).resolves.toBe("scheduled:agent-1:run-1");

    expect(seenConfigs).toEqual([
      {
        agentId: "agent-1",
        sessionId: "scheduled:agent-1:run-1",
        stateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
        initialMessages: [
          {
            id: "scheduled:agent-1:run-1:0",
            senderId: "scheduler",
            content: [{ kind: "text", text: "hello" }],
            timestamp: expect.any(Number),
          },
        ],
      },
    ]);
  });

  test("default scheduled task activity materializes resume payloads for dispatch", async () => {
    const seenConfigs: unknown[] = [];
    const activities = createDefaultScheduledTaskActivities({
      runAgentWorkflow: async (config) => {
        seenConfigs.push(config);
      },
    });

    await expect(
      activities.dispatchToAgent({
        mode: "dispatch",
        agentId: "agent-1" as never,
        stateRefs: { lastTurnId: "turn-3", turnsProcessed: 3 },
        input: { kind: "resume", state: { engineId: "engine-1", data: { ok: true } } },
      }),
    ).resolves.toBeUndefined();

    expect(seenConfigs).toEqual([
      {
        agentId: "agent-1",
        sessionId: "agent-1",
        stateRefs: { lastTurnId: "turn-3", turnsProcessed: 3 },
        initialMessages: [
          {
            id: "agent-1:resume",
            senderId: "scheduler",
            content: [],
            timestamp: expect.any(Number),
            resumeState: { engineId: "engine-1", data: { ok: true } },
          },
        ],
      },
    ]);
  });
});
