import { describe, expect, mock, test } from "bun:test";
import { agentId, taskId } from "@koi/core";
import type { TemporalClientLike, WorkflowExecutionStatus } from "../scheduler.js";
import { createTemporalScheduler } from "../scheduler.js";

const A1 = agentId("agent-1");
const AA = agentId("agent-a");
const AB = agentId("agent-b");

function makeClient(): TemporalClientLike {
  return {
    workflow: {
      start: mock(async () => ({ workflowId: "wf-1" })),
      cancel: mock(async () => {}),
      // describe absent → no Temporal reconciliation (process-local state only)
    },
    schedule: {
      create: mock(async () => {}),
      delete: mock(async () => {}),
      pause: mock(async () => {}),
      unpause: mock(async () => {}),
    },
  };
}

function makeClientWithDescribe(
  statusFn: (workflowId: string) => WorkflowExecutionStatus,
): TemporalClientLike {
  return {
    workflow: {
      start: mock(async () => ({ workflowId: "wf-1" })),
      cancel: mock(async () => {}),
      describe: mock(async (id: string) => statusFn(id)),
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

  test("stats reflects submitted tasks (no describe → pending, no reconciliation)", async () => {
    const client = makeClient();
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    await sched.submit(A1, { kind: "text", text: "a" }, "dispatch");
    await sched.submit(A1, { kind: "text", text: "b" }, "dispatch");
    // Tasks remain pending until Temporal sends an execution-start signal
    expect(sched.stats().pending).toBe(2);
    expect(sched.stats().running).toBe(0);
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
    expect(sched.stats().running).toBe(0);
    expect(sched.stats().pending).toBe(0);
  });

  test("schedule omits sessionId from workflow args — each firing derives session from Temporal workflowId", async () => {
    const client = makeClient();
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    await sched.schedule("0 * * * *", A1, { kind: "text", text: "tick" }, "dispatch");
    const createCall = (client.schedule.create as ReturnType<typeof mock>).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    const action = createCall[1].action as Record<string, unknown>;
    const args = action.args as [Record<string, unknown>];
    // sessionId must NOT be present — cron firings must NOT share a session
    expect(args[0]).not.toHaveProperty("sessionId");
    // but agentId and mode must still be present
    expect(args[0]).toHaveProperty("agentId");
    expect(args[0]).toHaveProperty("mode");
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
    const foreignId = taskId("task-external-999");
    const result = await sched.cancel(foreignId);
    expect(result).toBe(true);
    expect(client.workflow.cancel).toHaveBeenCalledTimes(1);
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
    const resumeState = { engineId: "eng-1", data: { checkpoint: "abc123", step: 42 } };
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

  // ---------------------------------------------------------------------------
  // Temporal reconciliation via describe
  // Reconciliation is triggered by query(). stats() reads the already-reconciled
  // cache — call query({}) first to get up-to-date stats.
  // ---------------------------------------------------------------------------

  test("reconcile RUNNING: task transitions to running and emits task:started", async () => {
    const client = makeClientWithDescribe(() => ({ status: "RUNNING", startTime: 1000 }));
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    const events: string[] = [];
    sched.watch((e) => events.push(e.kind));
    await sched.submit(A1, { kind: "text", text: "x" }, "dispatch");
    await sched.query({}); // triggers reconciliation
    expect(sched.stats().running).toBe(1);
    expect(sched.stats().pending).toBe(0);
    expect(events).toContain("task:started");
    await sched[Symbol.asyncDispose]();
  });

  test("reconcile COMPLETED: task removed from active, added to history, emits task:completed", async () => {
    const client = makeClientWithDescribe(() => ({
      status: "COMPLETED",
      startTime: 1000,
      closeTime: 2000,
    }));
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    const events: string[] = [];
    sched.watch((e) => events.push(e.kind));
    await sched.submit(A1, { kind: "text", text: "x" }, "dispatch");
    const results = await sched.query({}); // triggers reconciliation
    expect(results).toHaveLength(0); // removed from active tasks
    expect(events).toContain("task:completed");
    const hist = await sched.history({});
    expect(hist).toHaveLength(1);
    expect(hist[0]?.status).toBe("completed");
    expect(hist[0]?.durationMs).toBe(1000);
    await sched[Symbol.asyncDispose]();
  });

  test("reconcile FAILED: task removed, added to history as failed, emits task:failed", async () => {
    const client = makeClientWithDescribe(() => ({
      status: "FAILED",
      startTime: 1000,
      closeTime: 3000,
      failure: { message: "boom" },
    }));
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    const events: string[] = [];
    sched.watch((e) => events.push(e.kind));
    await sched.submit(A1, { kind: "text", text: "x" }, "dispatch");
    await sched.query({}); // triggers reconciliation
    expect(events).toContain("task:failed");
    const hist = await sched.history({});
    expect(hist).toHaveLength(1);
    expect(hist[0]?.status).toBe("failed");
    expect(hist[0]?.error).toBe("boom");
    await sched[Symbol.asyncDispose]();
  });

  test("reconcile TIMED_OUT: task added to history as failed with timeout message", async () => {
    const client = makeClientWithDescribe(() => ({
      status: "TIMED_OUT",
      startTime: 1000,
      closeTime: 4000,
    }));
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    const events: string[] = [];
    sched.watch((e) => events.push(e.kind));
    await sched.submit(A1, { kind: "text", text: "x" }, "dispatch");
    await sched.query({});
    expect(events).toContain("task:failed");
    const hist = await sched.history({});
    expect(hist[0]?.error).toBe("workflow timed out");
    await sched[Symbol.asyncDispose]();
  });

  test("reconcile TERMINATED: task removed silently, emits task:cancelled", async () => {
    const client = makeClientWithDescribe(() => ({ status: "TERMINATED" }));
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    const events: string[] = [];
    sched.watch((e) => events.push(e.kind));
    await sched.submit(A1, { kind: "text", text: "x" }, "dispatch");
    await sched.query({});
    expect(sched.stats().pending).toBe(0);
    expect(events).toContain("task:cancelled");
    await sched[Symbol.asyncDispose]();
  });

  test("history() filters by agentId", async () => {
    const client = makeClientWithDescribe(() => ({
      status: "COMPLETED",
      startTime: 0,
      closeTime: 1,
    }));
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    await sched.submit(AA, { kind: "text", text: "x" }, "dispatch");
    await sched.submit(AB, { kind: "text", text: "y" }, "dispatch");
    await sched.query({}); // reconcile both to completed
    const forA = await sched.history({ agentId: AA });
    expect(forA).toHaveLength(1);
    expect(forA[0]?.agentId).toBe(AA);
    await sched[Symbol.asyncDispose]();
  });

  test("history() filter by status=failed", async () => {
    const client = makeClientWithDescribe(() => ({
      status: "FAILED",
      startTime: 0,
      closeTime: 1,
    }));
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    await sched.submit(A1, { kind: "text", text: "x" }, "dispatch");
    await sched.query({});
    expect(await sched.history({ status: "failed" })).toHaveLength(1);
    expect(await sched.history({ status: "completed" })).toHaveLength(0);
    await sched[Symbol.asyncDispose]();
  });

  test("history() limit caps results", async () => {
    const client = makeClientWithDescribe(() => ({
      status: "COMPLETED",
      startTime: 0,
      closeTime: 1,
    }));
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    await sched.submit(A1, { kind: "text", text: "a" }, "dispatch");
    await sched.submit(A1, { kind: "text", text: "b" }, "dispatch");
    await sched.submit(A1, { kind: "text", text: "c" }, "dispatch");
    await sched.query({}); // reconcile all three
    expect(await sched.history({ limit: 2 })).toHaveLength(2);
    await sched[Symbol.asyncDispose]();
  });

  test("describe error is swallowed — task stays pending", async () => {
    const client: TemporalClientLike = {
      workflow: {
        start: mock(async () => ({ workflowId: "wf-1" })),
        cancel: mock(async () => {}),
        describe: mock(async () => {
          throw new Error("network error");
        }),
      },
      schedule: {
        create: mock(async () => {}),
        delete: mock(async () => {}),
        pause: mock(async () => {}),
        unpause: mock(async () => {}),
      },
    };
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    await sched.submit(A1, { kind: "text", text: "x" }, "dispatch");
    await sched.query({}); // reconcile attempt fails silently
    expect(sched.stats().pending).toBe(1); // still pending
    await sched[Symbol.asyncDispose]();
  });
});
