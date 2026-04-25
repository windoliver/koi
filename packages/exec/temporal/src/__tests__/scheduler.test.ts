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

  test("schedule passes raw input (not pre-computed messages) so each firing gets unique message identity", async () => {
    const client = makeClient();
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    const engineInput = { kind: "text" as const, text: "tick" };
    await sched.schedule("0 * * * *", A1, engineInput, "dispatch");
    const createCall = (client.schedule.create as ReturnType<typeof mock>).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    const action = createCall[1].action as Record<string, unknown>;
    const args = action.args as [Record<string, unknown>];
    // raw input must be present so each firing constructs per-run message IDs
    expect(args[0]).toHaveProperty("input");
    expect(args[0].input).toEqual(engineInput);
    // messages must NOT be pre-computed into the schedule action
    expect(args[0]).not.toHaveProperty("messages");
    // sessionId must NOT be present — each firing derives its session from workflowId
    expect(args[0]).not.toHaveProperty("sessionId");
    // agentId and mode must still be present
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
    expect(action.workflowExecutionTimeout).toBe(60000);
    expect((action.retryPolicy as Record<string, unknown>).maximumAttempts).toBe(3);
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
    expect(opts.workflowExecutionTimeout).toBe(30000);
    expect((opts.retryPolicy as Record<string, unknown>).maximumAttempts).toBe(2);
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
    const args = startCall[1].args as [Record<string, unknown>];
    const messages = args[0].messages as [Record<string, unknown>];
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

  test("reconcile TERMINATED: task removed, added to history as failed, emits task:cancelled", async () => {
    const client = makeClientWithDescribe(() => ({
      status: "TERMINATED",
      startTime: 1000,
      closeTime: 2000,
    }));
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    const events: string[] = [];
    sched.watch((e) => events.push(e.kind));
    await sched.submit(A1, { kind: "text", text: "x" }, "dispatch");
    await sched.query({});
    expect(sched.stats().pending).toBe(0);
    expect(events).toContain("task:cancelled");
    const hist = await sched.history({});
    expect(hist).toHaveLength(1);
    expect(hist[0]?.status).toBe("failed");
    expect(hist[0]?.error).toBe("workflow terminated");
    await sched[Symbol.asyncDispose]();
  });

  test("cancel() writes a failed history record before removing the task", async () => {
    const client = makeClient();
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    const id = await sched.submit(A1, { kind: "text", text: "x" }, "dispatch");
    await sched.cancel(id);
    expect(sched.stats().pending).toBe(0);
    const hist = await sched.history({});
    expect(hist).toHaveLength(1);
    expect(hist[0]?.status).toBe("failed");
    expect(hist[0]?.error).toBe("workflow cancelled");
    await sched[Symbol.asyncDispose]();
  });

  test("concurrent query() calls on the same task produce exactly one history entry", async () => {
    let resolveDescribe!: () => void;
    const blockedDescribe = new Promise<void>((r) => {
      resolveDescribe = r;
    });
    let _describeCallCount = 0;
    const client: TemporalClientLike = {
      workflow: {
        start: mock(async () => ({ workflowId: "wf-1" })),
        cancel: mock(async () => {}),
        describe: mock(async (): Promise<WorkflowExecutionStatus> => {
          _describeCallCount++;
          await blockedDescribe;
          return { status: "COMPLETED", startTime: 0, closeTime: 1 };
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
    // Launch two concurrent query() calls
    const [q1, q2] = [sched.query({}), sched.query({})];
    resolveDescribe();
    await Promise.all([q1, q2]);
    const hist = await sched.history({});
    expect(hist).toHaveLength(1); // only one entry despite two concurrent queries
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

  test("submit() fails closed when describe unavailable and AlreadyExistsError on stable ID", async () => {
    const alreadyStarted = {
      name: "WorkflowExecutionAlreadyStartedError",
      message: "already started",
    };
    const client: TemporalClientLike = {
      workflow: {
        start: mock(async () => {
          throw alreadyStarted;
        }),
        cancel: mock(async () => {}),
        // NO describe — must fail closed
      },
      schedule: {
        create: mock(async () => {}),
        delete: mock(async () => {}),
        pause: mock(async () => {}),
        unpause: mock(async () => {}),
      },
    };
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    await expect(
      sched.submit(A1, { kind: "text", text: "hi" }, "dispatch", {
        metadata: { workflowId: "my-stable-id" },
      }),
    ).rejects.toThrow("describe()");
    expect(sched.stats().pending).toBe(0); // no phantom task registered
    await sched[Symbol.asyncDispose]();
  });

  test("submit() rethrows error when no stable ID supplied (non-idempotent path)", async () => {
    const client: TemporalClientLike = {
      workflow: {
        start: mock(async () => {
          throw new Error("workflow start failed");
        }),
        cancel: mock(async () => {}),
      },
      schedule: {
        create: mock(async () => {}),
        delete: mock(async () => {}),
        pause: mock(async () => {}),
        unpause: mock(async () => {}),
      },
    };
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    await expect(sched.submit(A1, { kind: "text", text: "hi" }, "dispatch")).rejects.toThrow(
      "workflow start failed",
    );
    expect(sched.stats().pending).toBe(0); // no phantom task
    await sched[Symbol.asyncDispose]();
  });

  test("schedule() fails closed when schedule.get unavailable and AlreadyExistsError on stable ID", async () => {
    const alreadyExists = { name: "AlreadyExistsError", message: "schedule already exists" };
    const client: TemporalClientLike = {
      workflow: {
        start: mock(async () => ({ workflowId: "wf-1" })),
        cancel: mock(async () => {}),
      },
      schedule: {
        create: mock(async () => {
          throw alreadyExists;
        }),
        delete: mock(async () => {}),
        pause: mock(async () => {}),
        unpause: mock(async () => {}),
        // NO get — must fail closed
      },
    };
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    await expect(
      sched.schedule("0 * * * *", A1, { kind: "text", text: "tick" }, "dispatch", {
        metadata: { scheduleId: "my-stable-sched" },
      }),
    ).rejects.toThrow("schedule.get()");
    expect(sched.stats().activeSchedules).toBe(0); // no phantom schedule registered
    await sched[Symbol.asyncDispose]();
  });

  test("schedule() accepts stable-sched replay when get confirms full fingerprint match", async () => {
    const alreadyExists = { name: "AlreadyExistsError", message: "schedule already exists" };
    const inputFingerprint = JSON.stringify({ kind: "text", text: "tick" });
    const client: TemporalClientLike = {
      workflow: {
        start: mock(async () => ({ workflowId: "wf-1" })),
        cancel: mock(async () => {}),
      },
      schedule: {
        create: mock(async () => {
          throw alreadyExists;
        }),
        delete: mock(async () => {}),
        pause: mock(async () => {}),
        unpause: mock(async () => {}),
        get: mock(async () => ({
          memo: {
            agentId: A1,
            mode: "dispatch",
            expression: "0 * * * *",
            inputFingerprint,
            // timezone absent in both sides — both undefined → match
          },
        })),
      },
    };
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    const id = await sched.schedule("0 * * * *", A1, { kind: "text", text: "tick" }, "dispatch", {
      metadata: { scheduleId: "my-stable-sched" },
    });
    expect(String(id)).toBe("my-stable-sched");
    expect(sched.stats().activeSchedules).toBe(1);
    await sched[Symbol.asyncDispose]();
  });

  test("schedule() rejects replay when timezone differs", async () => {
    const alreadyExists = { name: "AlreadyExistsError", message: "schedule already exists" };
    const inputFingerprint = JSON.stringify({ kind: "text", text: "tick" });
    const client: TemporalClientLike = {
      workflow: {
        start: mock(async () => ({ workflowId: "wf-1" })),
        cancel: mock(async () => {}),
      },
      schedule: {
        create: mock(async () => {
          throw alreadyExists;
        }),
        delete: mock(async () => {}),
        pause: mock(async () => {}),
        unpause: mock(async () => {}),
        get: mock(async () => ({
          memo: {
            agentId: A1,
            mode: "dispatch",
            expression: "0 * * * *",
            timezone: "America/New_York", // different timezone
            inputFingerprint,
          },
        })),
      },
    };
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    await expect(
      sched.schedule("0 * * * *", A1, { kind: "text", text: "tick" }, "dispatch", {
        metadata: { scheduleId: "my-stable-sched" },
        timezone: "UTC",
      }),
    ).rejects.toThrow("collision");
    expect(sched.stats().activeSchedules).toBe(0);
    await sched[Symbol.asyncDispose]();
  });

  test("schedule() rejects replay when memo is absent (fail closed)", async () => {
    const alreadyExists = { name: "AlreadyExistsError", message: "schedule already exists" };
    const client: TemporalClientLike = {
      workflow: {
        start: mock(async () => ({ workflowId: "wf-1" })),
        cancel: mock(async () => {}),
      },
      schedule: {
        create: mock(async () => {
          throw alreadyExists;
        }),
        delete: mock(async () => {}),
        pause: mock(async () => {}),
        unpause: mock(async () => {}),
        get: mock(async () => ({
          /* no memo */
        })),
      },
    };
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    await expect(
      sched.schedule("0 * * * *", A1, { kind: "text", text: "tick" }, "dispatch", {
        metadata: { scheduleId: "my-stable-sched" },
      }),
    ).rejects.toThrow("collision");
    expect(sched.stats().activeSchedules).toBe(0);
    await sched[Symbol.asyncDispose]();
  });

  test("schedule() throws on collision when get reveals different cron expression", async () => {
    const alreadyExists = { name: "AlreadyExistsError", message: "schedule already exists" };
    const client: TemporalClientLike = {
      workflow: {
        start: mock(async () => ({ workflowId: "wf-1" })),
        cancel: mock(async () => {}),
      },
      schedule: {
        create: mock(async () => {
          throw alreadyExists;
        }),
        delete: mock(async () => {}),
        pause: mock(async () => {}),
        unpause: mock(async () => {}),
        get: mock(async () => ({
          memo: { agentId: A1, mode: "dispatch", expression: "0 0 * * *" }, // different expression
        })),
      },
    };
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    await expect(
      sched.schedule("0 * * * *", A1, { kind: "text", text: "tick" }, "dispatch", {
        metadata: { scheduleId: "my-stable-sched" },
      }),
    ).rejects.toThrow("collision");
    expect(sched.stats().activeSchedules).toBe(0); // no phantom schedule
    await sched[Symbol.asyncDispose]();
  });

  test("submit() uses metadata.workflowId as stable workflow ID when provided", async () => {
    const client = makeClient();
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    const id = await sched.submit(A1, { kind: "text", text: "hi" }, "dispatch", {
      metadata: { workflowId: "my-stable-id" },
    });
    expect(String(id)).toBe("my-stable-id");
    const [_type, startOpts] = (client.workflow.start as ReturnType<typeof mock>).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(startOpts.workflowId).toBe("my-stable-id");
    await sched[Symbol.asyncDispose]();
  });

  test("schedule() uses metadata.scheduleId as stable schedule ID when provided", async () => {
    const client = makeClient();
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    const id = await sched.schedule("0 * * * *", A1, { kind: "text", text: "hi" }, "dispatch", {
      metadata: { scheduleId: "my-stable-sched" },
    });
    expect(String(id)).toBe("my-stable-sched");
    const [schedId] = (client.schedule.create as ReturnType<typeof mock>).mock.calls[0] as [string];
    expect(schedId).toBe("my-stable-sched");
    await sched[Symbol.asyncDispose]();
  });

  test("query() filter by priority returns only matching tasks", async () => {
    const client = makeClient();
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    await sched.submit(A1, { kind: "text", text: "hi" }, "dispatch", { priority: 1 });
    await sched.submit(A1, { kind: "text", text: "lo" }, "dispatch", { priority: 9 });
    const highPri = await sched.query({ priority: 1 });
    expect(highPri).toHaveLength(1);
    const lowPri = await sched.query({ priority: 9 });
    expect(lowPri).toHaveLength(1);
    await sched[Symbol.asyncDispose]();
  });

  test("query() limit caps returned task count", async () => {
    const client = makeClient();
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    await sched.submit(A1, { kind: "text", text: "a" }, "dispatch");
    await sched.submit(A1, { kind: "text", text: "b" }, "dispatch");
    await sched.submit(A1, { kind: "text", text: "c" }, "dispatch");
    const limited = await sched.query({ limit: 2 });
    expect(limited).toHaveLength(2);
    await sched[Symbol.asyncDispose]();
  });

  test("submit() stores full fingerprint in workflow memo for collision detection", async () => {
    const client = makeClient();
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    await sched.submit(A1, { kind: "text", text: "hi" }, "dispatch");
    const [_type, startOpts] = (client.workflow.start as ReturnType<typeof mock>).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    const memo = startOpts.memo as Record<string, unknown>;
    expect(memo.agentId).toBe(A1);
    expect(memo.mode).toBe("dispatch");
    expect(typeof memo.inputFingerprint).toBe("string");
    // inputFingerprint must be the serialized engine input
    expect(memo.inputFingerprint).toBe(JSON.stringify({ kind: "text", text: "hi" }));
    await sched[Symbol.asyncDispose]();
  });

  test("submit() fails closed when describe throws during ownership verification", async () => {
    const alreadyStarted = { name: "WorkflowExecutionAlreadyStartedError", message: "started" };
    const client: TemporalClientLike = {
      workflow: {
        start: mock(async () => {
          throw alreadyStarted;
        }),
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
    await expect(
      sched.submit(A1, { kind: "text", text: "hi" }, "dispatch", {
        metadata: { workflowId: "stable-id" },
      }),
    ).rejects.toThrow("describe call failed");
    expect(sched.stats().pending).toBe(0);
    await sched[Symbol.asyncDispose]();
  });

  test("submit() throws on stable-ID collision when describe reveals different agentId or mode", async () => {
    const alreadyStarted = { name: "WorkflowExecutionAlreadyStartedError", message: "started" };
    const client: TemporalClientLike = {
      workflow: {
        start: mock(async () => {
          throw alreadyStarted;
        }),
        cancel: mock(async () => {}),
        describe: mock(
          async (): Promise<WorkflowExecutionStatus> => ({
            status: "RUNNING",
            memo: { agentId: "other-agent", mode: "spawn" }, // different agent + mode
          }),
        ),
      },
      schedule: {
        create: mock(async () => {}),
        delete: mock(async () => {}),
        pause: mock(async () => {}),
        unpause: mock(async () => {}),
      },
    };
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    await expect(
      sched.submit(A1, { kind: "text", text: "hi" }, "dispatch", {
        metadata: { workflowId: "stable-id" },
      }),
    ).rejects.toThrow("collision");
    expect(sched.stats().pending).toBe(0); // no phantom task registered
    await sched[Symbol.asyncDispose]();
  });

  test("submit() accepts stable-ID replay when describe confirms full fingerprint match", async () => {
    const alreadyStarted = { name: "WorkflowExecutionAlreadyStartedError", message: "started" };
    const engineInput = { kind: "text" as const, text: "hi" };
    const inputFingerprint = JSON.stringify({ kind: "text", text: "hi" });
    const client: TemporalClientLike = {
      workflow: {
        start: mock(async () => {
          throw alreadyStarted;
        }),
        cancel: mock(async () => {}),
        describe: mock(
          async (): Promise<WorkflowExecutionStatus> => ({
            status: "RUNNING",
            memo: { agentId: A1, mode: "dispatch", inputFingerprint },
          }),
        ),
      },
      schedule: {
        create: mock(async () => {}),
        delete: mock(async () => {}),
        pause: mock(async () => {}),
        unpause: mock(async () => {}),
      },
    };
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    const id = await sched.submit(A1, engineInput, "dispatch", {
      metadata: { workflowId: "stable-id" },
    });
    expect(String(id)).toBe("stable-id");
    expect(sched.stats().pending).toBe(1);
    await sched[Symbol.asyncDispose]();
  });

  test("submit() does not register phantom pending task when replayed workflow already completed", async () => {
    const alreadyStarted = { name: "WorkflowExecutionAlreadyStartedError", message: "started" };
    const inputFingerprint = JSON.stringify({ kind: "text", text: "hi" });
    const client: TemporalClientLike = {
      workflow: {
        start: mock(async () => {
          throw alreadyStarted;
        }),
        cancel: mock(async () => {}),
        describe: mock(
          async (): Promise<WorkflowExecutionStatus> => ({
            status: "COMPLETED", // already finished
            memo: { agentId: A1, mode: "dispatch", inputFingerprint },
          }),
        ),
      },
      schedule: {
        create: mock(async () => {}),
        delete: mock(async () => {}),
        pause: mock(async () => {}),
        unpause: mock(async () => {}),
      },
    };
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    const id = await sched.submit(A1, { kind: "text", text: "hi" }, "dispatch", {
      metadata: { workflowId: "stable-id" },
    });
    expect(String(id)).toBe("stable-id");
    // Terminal workflow must NOT register as pending — no phantom task
    expect(sched.stats().pending).toBe(0);
    expect(sched.stats().running).toBe(0);
    await sched[Symbol.asyncDispose]();
  });

  test("submit() rejects replay when memo is absent (fail closed — no memo means cannot verify)", async () => {
    const alreadyStarted = { name: "WorkflowExecutionAlreadyStartedError", message: "started" };
    const client: TemporalClientLike = {
      workflow: {
        start: mock(async () => {
          throw alreadyStarted;
        }),
        cancel: mock(async () => {}),
        describe: mock(
          async (): Promise<WorkflowExecutionStatus> => ({
            status: "RUNNING",
            // no memo — legacy or manually created workflow
          }),
        ),
      },
      schedule: {
        create: mock(async () => {}),
        delete: mock(async () => {}),
        pause: mock(async () => {}),
        unpause: mock(async () => {}),
      },
    };
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    await expect(
      sched.submit(A1, { kind: "text", text: "hi" }, "dispatch", {
        metadata: { workflowId: "stable-id" },
      }),
    ).rejects.toThrow("collision");
    expect(sched.stats().pending).toBe(0);
    await sched[Symbol.asyncDispose]();
  });

  test("submit() rejects replay when input fingerprint differs (same stable ID, different work)", async () => {
    const alreadyStarted = { name: "WorkflowExecutionAlreadyStartedError", message: "started" };
    const otherFingerprint = JSON.stringify({ kind: "text", text: "different-text" });
    const client: TemporalClientLike = {
      workflow: {
        start: mock(async () => {
          throw alreadyStarted;
        }),
        cancel: mock(async () => {}),
        describe: mock(
          async (): Promise<WorkflowExecutionStatus> => ({
            status: "RUNNING",
            memo: { agentId: A1, mode: "dispatch", inputFingerprint: otherFingerprint },
          }),
        ),
      },
      schedule: {
        create: mock(async () => {}),
        delete: mock(async () => {}),
        pause: mock(async () => {}),
        unpause: mock(async () => {}),
      },
    };
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    await expect(
      sched.submit(A1, { kind: "text", text: "hi" }, "dispatch", {
        metadata: { workflowId: "stable-id" },
      }),
    ).rejects.toThrow("collision");
    expect(sched.stats().pending).toBe(0);
    await sched[Symbol.asyncDispose]();
  });

  test("schedule() strips non-serializable callHandlers from input before Temporal transport", async () => {
    const client = makeClient();
    const sched = createTemporalScheduler({ client, taskQueue: "test" });
    const engineInput = {
      kind: "text" as const,
      text: "tick",
      callHandlers: { handle: () => {} },
    } as unknown as import("@koi/core").EngineInput;
    await sched.schedule("0 * * * *", A1, engineInput, "dispatch");
    const createCall = (client.schedule.create as ReturnType<typeof mock>).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    const action = createCall[1].action as Record<string, unknown>;
    const args = action.args as [Record<string, unknown>];
    expect(args[0].input).not.toHaveProperty("callHandlers");
    expect(args[0].input).toHaveProperty("kind", "text");
    expect(args[0].input).toHaveProperty("text", "tick");
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
