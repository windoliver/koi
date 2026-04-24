import { describe, expect, mock, test } from "bun:test";
import { agentId, taskId } from "@koi/core";
import type { TemporalClientLike } from "../scheduler.js";
import { createTemporalScheduler } from "../scheduler.js";

const A1 = agentId("agent-1");
const AA = agentId("agent-a");
const AB = agentId("agent-b");

function makeClient(): TemporalClientLike {
  return {
    workflow: {
      start: mock(async () => ({ workflowId: "wf-1" })),
      cancel: mock(async () => {}),
    },
    schedule: {
      create: mock(async () => {}),
      delete: mock(async () => {}),
      pause: mock(async () => {}),
      unpause: mock(async () => {}),
    },
  };
}

describe("createTemporalScheduler", () => {
  test("submit starts a workflow and returns a TaskId", async () => {
    const client = makeClient();
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    const id = await sched.submit(A1, { kind: "text", text: "hello" }, "dispatch");
    expect(typeof id).toBe("string");
    expect(client.workflow.start).toHaveBeenCalledTimes(1);
    await sched[Symbol.asyncDispose]();
  });

  test("cancel calls workflow.cancel and returns true", async () => {
    const client = makeClient();
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    const id = await sched.submit(A1, { kind: "text", text: "hi" }, "dispatch");
    const result = await sched.cancel(id);
    expect(result).toBe(true);
    expect(client.workflow.cancel).toHaveBeenCalledTimes(1);
    await sched[Symbol.asyncDispose]();
  });

  test("cancel returns false when client throws", async () => {
    const failClient: TemporalClientLike = {
      workflow: {
        start: mock(async () => ({ workflowId: "x" })),
        cancel: mock(async () => {
          throw new Error("not found");
        }),
      },
      schedule: {
        create: mock(async () => {}),
        delete: mock(async () => {}),
        pause: mock(async () => {}),
        unpause: mock(async () => {}),
      },
    };
    const sched = createTemporalScheduler({ client: failClient, taskQueue: "test" });
    const id = await sched.submit(A1, { kind: "text", text: "x" }, "dispatch");
    const result = await sched.cancel(id);
    expect(result).toBe(false);
    await sched[Symbol.asyncDispose]();
  });

  test("schedule creates a Temporal schedule and returns ScheduleId", async () => {
    const client = makeClient();
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    const id = await sched.schedule("0 * * * *", A1, { kind: "text", text: "tick" }, "dispatch");
    expect(typeof id).toBe("string");
    expect(client.schedule.create).toHaveBeenCalledTimes(1);
    await sched[Symbol.asyncDispose]();
  });

  test("unschedule deletes a Temporal schedule and returns true", async () => {
    const client = makeClient();
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    const id = await sched.schedule("0 * * * *", A1, { kind: "text", text: "tick" }, "dispatch");
    expect(await sched.unschedule(id)).toBe(true);
    expect(client.schedule.delete).toHaveBeenCalledTimes(1);
    await sched[Symbol.asyncDispose]();
  });

  test("pause / resume delegate to client", async () => {
    const client = makeClient();
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    const id = await sched.schedule("0 * * * *", A1, { kind: "text", text: "tick" }, "dispatch");
    expect(await sched.pause(id)).toBe(true);
    expect(await sched.resume(id)).toBe(true);
    expect(client.schedule.pause).toHaveBeenCalledTimes(1);
    expect(client.schedule.unpause).toHaveBeenCalledTimes(1);
    await sched[Symbol.asyncDispose]();
  });

  test("stats reflects submitted tasks", async () => {
    const client = makeClient();
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    await sched.submit(A1, { kind: "text", text: "a" }, "dispatch");
    await sched.submit(A1, { kind: "text", text: "b" }, "dispatch");
    const stats = sched.stats();
    // Tasks remain pending until Temporal sends an execution-start signal
    expect(stats.pending).toBe(2);
    expect(stats.running).toBe(0);
    await sched[Symbol.asyncDispose]();
  });

  test("watch listener fires on submit", async () => {
    const client = makeClient();
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    const events: string[] = [];
    const unsub = sched.watch((e) => events.push(e.kind));
    await sched.submit(A1, { kind: "text", text: "hello" }, "dispatch");
    expect(events).toContain("task:submitted");
    unsub();
    await sched[Symbol.asyncDispose]();
  });

  test("query filters by agentId", async () => {
    const client = makeClient();
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    await sched.submit(AA, { kind: "text", text: "x" }, "dispatch");
    await sched.submit(AB, { kind: "text", text: "y" }, "dispatch");
    const results = await sched.query({ agentId: AA });
    expect(results).toHaveLength(1);
    expect(results[0]?.agentId).toBe(AA);
    await sched[Symbol.asyncDispose]();
  });

  test("asyncDispose clears all state", async () => {
    const client = makeClient();
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    await sched.submit(A1, { kind: "text", text: "x" }, "dispatch");
    await sched[Symbol.asyncDispose]();
    const stats = sched.stats();
    expect(stats.running).toBe(0);
  });

  test("schedule passes sessionId in workflow args (same shape as submit)", async () => {
    const client = makeClient();
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    await sched.schedule("0 * * * *", A1, { kind: "text", text: "tick" }, "dispatch");
    const createCall = (client.schedule.create as ReturnType<typeof mock>).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    const action = createCall[1]["action"] as Record<string, unknown>;
    const args = action["args"] as [Record<string, unknown>];
    expect(args[0]).toHaveProperty("sessionId");
    await sched[Symbol.asyncDispose]();
  });

  test("pause updates in-memory state — stats reflect change", async () => {
    const client = makeClient();
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    const id = await sched.schedule("0 * * * *", A1, { kind: "text", text: "tick" }, "dispatch");
    expect(sched.stats().activeSchedules).toBe(1);
    expect(sched.stats().pausedSchedules).toBe(0);
    await sched.pause(id);
    expect(sched.stats().activeSchedules).toBe(0);
    expect(sched.stats().pausedSchedules).toBe(1);
    await sched[Symbol.asyncDispose]();
  });

  test("resume updates in-memory state — stats reflect change", async () => {
    const client = makeClient();
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    const id = await sched.schedule("0 * * * *", A1, { kind: "text", text: "tick" }, "dispatch");
    await sched.pause(id);
    await sched.resume(id);
    expect(sched.stats().activeSchedules).toBe(1);
    expect(sched.stats().pausedSchedules).toBe(0);
    await sched[Symbol.asyncDispose]();
  });

  test("pause emits schedule:paused event", async () => {
    const client = makeClient();
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    const events: string[] = [];
    sched.watch((e) => events.push(e.kind));
    const id = await sched.schedule("0 * * * *", A1, { kind: "text", text: "tick" }, "dispatch");
    await sched.pause(id);
    expect(events).toContain("schedule:paused");
    await sched[Symbol.asyncDispose]();
  });

  test("cancel returns true and emits event even when task not in local cache", async () => {
    const client = makeClient();
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    const events: string[] = [];
    sched.watch((e) => events.push(e.kind));
    // Cancel a workflow ID that was never submitted to this scheduler instance
    // (simulates process-restart scenario where in-memory cache is empty)
    const foreignId = taskId("task-external-999");
    const result = await sched.cancel(foreignId);
    expect(result).toBe(true);
    expect(client.workflow.cancel).toHaveBeenCalledTimes(1);
    // No local task → no task:cancelled event emitted, but cancel still succeeds
    expect(events).not.toContain("task:cancelled");
    await sched[Symbol.asyncDispose]();
  });

  test("cancel emits task:cancelled (not task:failed) for known tasks", async () => {
    const client = makeClient();
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    const events: string[] = [];
    sched.watch((e) => events.push(e.kind));
    const id = await sched.submit(A1, { kind: "text", text: "x" }, "dispatch");
    await sched.cancel(id);
    expect(events).toContain("task:cancelled");
    expect(events).not.toContain("task:failed");
    await sched[Symbol.asyncDispose]();
  });

  test("schedule forwards timeoutMs and maxRetries into the workflow action", async () => {
    const client = makeClient();
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    await sched.schedule("0 * * * *", A1, { kind: "text", text: "tick" }, "dispatch", {
      timeoutMs: 60000,
      maxRetries: 3,
    });
    const createCall = (client.schedule.create as ReturnType<typeof mock>).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    const action = createCall[1].action as Record<string, unknown>;
    expect(action["workflowExecutionTimeout"]).toBe(60000);
    expect((action["retryPolicy"] as Record<string, unknown>)["maximumAttempts"]).toBe(3);
    await sched[Symbol.asyncDispose]();
  });

  test("submit forwards timeoutMs as workflowExecutionTimeout", async () => {
    const client = makeClient();
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    await sched.submit(A1, { kind: "text", text: "x" }, "dispatch", {
      timeoutMs: 30000,
      maxRetries: 2,
    });
    const startCall = (client.workflow.start as ReturnType<typeof mock>).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    const opts = startCall[1];
    expect(opts["workflowExecutionTimeout"]).toBe(30000);
    expect((opts["retryPolicy"] as Record<string, unknown>)["maximumAttempts"]).toBe(2);
    await sched[Symbol.asyncDispose]();
  });

  test("resume input state is forwarded to workflow args", async () => {
    const client = makeClient();
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    const resumeState = { checkpoint: "abc123", step: 42 };
    await sched.submit(A1, { kind: "resume", state: resumeState }, "dispatch");
    const startCall = (client.workflow.start as ReturnType<typeof mock>).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    const args = startCall[1]["args"] as [Record<string, unknown>];
    const messages = args[0]["messages"] as [Record<string, unknown>];
    expect(messages[0]).toHaveProperty("resumeState", resumeState);
    await sched[Symbol.asyncDispose]();
  });
});
