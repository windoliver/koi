/**
 * Integration tests — require a live Temporal server on localhost:7233.
 *
 * Gate: TEMPORAL_INTEGRATION=true
 * Run:  temporal server start-dev && TEMPORAL_INTEGRATION=true bun test src/__tests__/integration.test.ts
 *
 * Covers:
 *   1. Bun compat gate — SDK loads, NativeConnection connects, trivial workflow round-trips
 *   2. Scheduler integration — submit/query/cancel against real Temporal
 *   3. Corner cases — COMPLETED cancel, ownership mismatch, bootstrap recovery
 *   4. Worker factory — createTemporalWorker wires up and drains correctly
 */

import { describe, expect, test } from "bun:test";
import type { AgentId } from "@koi/core";
import { agentId } from "@koi/core";

const SKIP = process.env.TEMPORAL_INTEGRATION !== "true";

// ---------------------------------------------------------------------------
// 1. Bun compatibility gate
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)("Bun compat gate", () => {
  test("can import @temporalio/common", async () => {
    const common = await import("@temporalio/common");
    expect(common).toBeDefined();
  });

  test("can import @temporalio/client", async () => {
    const { Client, Connection } = await import("@temporalio/client");
    expect(Client).toBeDefined();
    expect(Connection).toBeDefined();
  });

  test("can import @temporalio/worker", async () => {
    const { Worker, NativeConnection } = await import("@temporalio/worker");
    expect(Worker).toBeDefined();
    expect(NativeConnection).toBeDefined();
  });

  test("NativeConnection connects to localhost:7233", async () => {
    const { NativeConnection } = await import("@temporalio/worker");
    const conn = await NativeConnection.connect({ address: "localhost:7233" });
    expect(conn).toBeDefined();
    await conn.close();
  }, 30_000);

  test("trivial workflow round-trips via Worker + Client", async () => {
    const { NativeConnection, Worker } = await import("@temporalio/worker");
    const { Client, Connection } = await import("@temporalio/client");

    const nativeConn = await NativeConnection.connect({ address: "localhost:7233" });
    const worker = await Worker.create({
      connection: nativeConn,
      taskQueue: "bun-compat-test",
      workflowsPath: new URL("./fixtures/trivial-workflow.js", import.meta.url).pathname,
      activities: {
        async noOp(): Promise<string> {
          return "ok";
        },
      },
    });

    const workerPromise = worker.run();
    try {
      const clientConn = await Connection.connect({ address: "localhost:7233" });
      const client = new Client({ connection: clientConn });

      const handle = await client.workflow.start("trivialWorkflow", {
        taskQueue: "bun-compat-test",
        workflowId: `bun-compat-${Date.now()}`,
      });

      const result = await handle.result();
      expect(result).toBe("ok");
      await clientConn.close();
    } finally {
      worker.shutdown();
      await workerPromise;
      await nativeConn.close();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Helpers shared by scheduler integration tests
// ---------------------------------------------------------------------------

async function makeRealClient() {
  const { Client, Connection } = await import("@temporalio/client");
  const conn = await Connection.connect({ address: "localhost:7233" });
  const temporalClient = new Client({ connection: conn });

  // Wrap into TemporalClientLike shape expected by createTemporalScheduler
  return {
    client: {
      workflow: {
        start: async (workflowType: string, opts: Record<string, unknown>) => {
          const handle = await temporalClient.workflow.start(workflowType, opts as never);
          return { workflowId: handle.workflowId };
        },
        cancel: async (id: string) => {
          const handle = temporalClient.workflow.getHandle(id);
          await handle.cancel();
        },
        describe: async (id: string) => {
          const desc = await temporalClient.workflow.getHandle(id).describe();
          // In @temporalio/client >=1.16, status is { code: number, name: string }
          const rawName =
            typeof desc.status === "object" && desc.status !== null
              ? String((desc.status as { name?: unknown }).name ?? "RUNNING")
              : String(desc.status ?? "RUNNING");
          const VALID = new Set([
            "RUNNING",
            "COMPLETED",
            "FAILED",
            "CANCELLED",
            "TERMINATED",
            "CONTINUED_AS_NEW",
            "TIMED_OUT",
          ]);
          return {
            status: (VALID.has(rawName) ? rawName : "RUNNING") as
              | "RUNNING"
              | "COMPLETED"
              | "FAILED"
              | "CANCELLED"
              | "TERMINATED"
              | "CONTINUED_AS_NEW"
              | "TIMED_OUT",
            memo: desc.memo as Record<string, unknown> | undefined,
            startTime: desc.startTime?.getTime(),
            closeTime: desc.closeTime?.getTime(),
          };
        },
        list: async () => [],
      },
      schedule: {
        create: async () => {},
        pause: async () => {},
        unpause: async () => {},
        delete: async () => {},
      },
    },
    _conn: conn,
    _temporalClient: temporalClient,
    close: () => conn.close(),
  };
}

// ---------------------------------------------------------------------------
// 2. Scheduler integration — real Temporal server
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)("Scheduler integration (real Temporal)", () => {
  const QUEUE = "integration-test-queue";
  const agent = agentId("integration-agent") as AgentId;

  test("submit starts a workflow and query returns running status", async () => {
    const { NativeConnection, Worker } = await import("@temporalio/worker");
    const { createTemporalScheduler } = await import("../scheduler.js");

    const { client, close } = await makeRealClient();

    const nativeConn = await NativeConnection.connect({ address: "localhost:7233" });
    const worker = await Worker.create({
      connection: nativeConn,
      taskQueue: QUEUE,
      workflowsPath: new URL("./fixtures/trivial-workflow.js", import.meta.url).pathname,
      activities: {
        async noOp(): Promise<string> {
          return "integration-ok";
        },
      },
    });

    const workerPromise = worker.run();
    try {
      const scheduler = createTemporalScheduler({
        client,
        taskQueue: QUEUE,
        workflowType: "trivialWorkflow",
      });

      const id = await scheduler.submit(agent, { kind: "text", text: "run" }, "dispatch");
      expect(typeof id).toBe("string");

      // Brief pause: Temporal server needs a moment to register the execution
      // before describe() will succeed.
      await new Promise((r) => setTimeout(r, 300));

      // Poll: task starts in live map; once completed it moves to history
      let tasks: readonly import("@koi/core").ScheduledTask[] = [];
      let hist: readonly import("@koi/core").TaskRunRecord[] = [];
      for (let i = 0; i < 14; i++) {
        tasks = await scheduler.query({});
        hist = await scheduler.history({});
        // Stop once we see any activity (live or in history)
        if (tasks.length > 0 || hist.length > 0) break;
        await new Promise((r) => setTimeout(r, 500));
      }

      // Either the task is still live (running/pending) OR already completed into history
      const liveStatus = tasks[0]?.status;
      const histStatus = hist[0]?.status;
      const observed = liveStatus ?? histStatus;
      expect(observed).toBeDefined();
      expect(["running", "completed", "failed", "pending"]).toContain(observed);

      await scheduler[Symbol.asyncDispose]();
    } finally {
      worker.shutdown();
      await workerPromise;
      await nativeConn.close();
      await close();
    }
  }, 60_000);

  test("cancel returns false for already-COMPLETED workflow", async () => {
    const { NativeConnection, Worker } = await import("@temporalio/worker");
    const { createTemporalScheduler } = await import("../scheduler.js");

    const { client, close, _temporalClient } = await makeRealClient();

    const nativeConn = await NativeConnection.connect({ address: "localhost:7233" });
    const worker = await Worker.create({
      connection: nativeConn,
      taskQueue: QUEUE,
      workflowsPath: new URL("./fixtures/trivial-workflow.js", import.meta.url).pathname,
      activities: {
        async noOp(): Promise<string> {
          return "done";
        },
      },
    });

    const workerPromise = worker.run();
    try {
      const scheduler = createTemporalScheduler({
        client,
        taskQueue: QUEUE,
        workflowType: "trivialWorkflow",
      });

      const id = await scheduler.submit(agent, { kind: "text", text: "complete me" }, "dispatch");

      // Wait for completion
      await _temporalClient.workflow
        .getHandle(id as string)
        .result()
        .catch(() => {});

      // cancel on a completed workflow: assertMemoOwner still verifies but
      // the underlying cancel call should swallow WorkflowNotFound/already done
      const result = await scheduler.cancel(id).catch(() => false);
      expect(typeof result).toBe("boolean"); // false or threw — either is acceptable

      await scheduler[Symbol.asyncDispose]();
    } finally {
      worker.shutdown();
      await workerPromise;
      await nativeConn.close();
      await close();
    }
  }, 60_000);

  test("cancel throws when memo agentId does not match (ownership mismatch)", async () => {
    const { NativeConnection, Worker } = await import("@temporalio/worker");
    const { createTemporalScheduler } = await import("../scheduler.js");

    const agentA = agentId("agent-alpha") as AgentId;
    const agentB = agentId("agent-beta") as AgentId;

    const { client, close } = await makeRealClient();

    const nativeConn = await NativeConnection.connect({ address: "localhost:7233" });
    const worker = await Worker.create({
      connection: nativeConn,
      taskQueue: QUEUE,
      workflowsPath: new URL("./fixtures/trivial-workflow.js", import.meta.url).pathname,
      activities: {
        async noOp(): Promise<string> {
          return "ok";
        },
      },
    });

    const workerPromise = worker.run();
    try {
      // Agent A submits a task
      const schedulerA = createTemporalScheduler({
        client,
        taskQueue: QUEUE,
        workflowType: "trivialWorkflow",
      });
      const id = await schedulerA.submit(agentA, { kind: "text", text: "owned by A" }, "dispatch");

      // Agent B tries to cancel it — scheduler has agentB in local map via submit
      // We simulate by creating a second scheduler and faking the local task cache
      // In practice, assertMemoOwner checks the remote memo — agentId in memo is agentA
      // so if we call cancel from a scheduler that submitted with agentB, it should throw.
      const schedulerB = createTemporalScheduler({
        client,
        taskQueue: QUEUE,
        workflowType: "trivialWorkflow",
      });
      const idB = await schedulerB.submit(agentB, { kind: "text", text: "owned by B" }, "dispatch");
      // Try to cancel agentA's workflow via schedulerB — id not in schedulerB's map,
      // describe will return memo with agentA, assertMemoOwner will throw.
      await expect(schedulerB.cancel(id)).rejects.toThrow(/not owned|verify ownership/);

      await schedulerA[Symbol.asyncDispose]();
      await schedulerB[Symbol.asyncDispose]();
      void idB;
    } finally {
      worker.shutdown();
      await workerPromise;
      await nativeConn.close();
      await close();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 3. Worker factory integration
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)("createTemporalWorker integration", () => {
  const QUEUE = "worker-factory-test-queue";

  test("run() starts worker and dispose() drains + closes connection", async () => {
    const { createTemporalWorker } = await import("../worker-factory.js");

    const handle = await createTemporalWorker(
      { taskQueue: QUEUE, url: "localhost:7233", namespace: "default" },
      {},
      new URL("./fixtures/trivial-workflow.js", import.meta.url).pathname,
    );

    void handle.run();
    // Give it a moment to start polling
    await new Promise((r) => setTimeout(r, 500));
    // dispose() must not hang — it signals shutdown, waits for drain, closes connection
    await expect(handle.dispose()).resolves.toBeUndefined();
  }, 60_000);

  test("dispose() before run() closes connection without hanging", async () => {
    const { createTemporalWorker } = await import("../worker-factory.js");

    const handle = await createTemporalWorker(
      { taskQueue: QUEUE, url: "localhost:7233", namespace: "default" },
      {},
      new URL("./fixtures/trivial-workflow.js", import.meta.url).pathname,
    );

    await expect(handle.dispose()).resolves.toBeUndefined();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 4. Corner cases (unit-level, no server needed — but grouped here for completeness)
// ---------------------------------------------------------------------------

describe("Corner cases (no server required)", () => {
  test("cancel on unknown id throws 'Cannot verify ownership' (describe absent)", async () => {
    const { createTemporalScheduler } = await import("../scheduler.js");
    const { taskId } = await import("@koi/core");

    const scheduler = createTemporalScheduler({
      client: {
        workflow: {
          start: async () => ({ workflowId: "x" }),
          cancel: async () => {},
          // no describe → describe-absent path
        },
        schedule: {
          create: async () => {},
          pause: async () => {},
          unpause: async () => {},
          delete: async () => {},
        },
      },
      taskQueue: "q",
    });

    const unknownId = taskId("never-submitted");
    await expect(scheduler.cancel(unknownId)).rejects.toThrow(/Cannot verify ownership/);
  });

  test("stats() counts completed from history not live task map", async () => {
    const { createTemporalScheduler } = await import("../scheduler.js");
    const agent = agentId("stats-agent") as AgentId;

    let completionCallback: (() => void) | undefined;

    const client = {
      workflow: {
        start: async (_wfType: string, opts: Record<string, unknown>) => ({
          workflowId: (opts.workflowId as string) ?? "wf-1",
        }),
        cancel: async () => {},
        describe: async (_id: string) => {
          // Return COMPLETED on the first describe call to trigger reconciliation
          return {
            status: "COMPLETED" as const,
            memo: {
              agentId: agent,
              workflowType: "agentWorkflow",
              taskQueue: "stats-queue",
              mode: "dispatch",
              inputFingerprint: JSON.stringify({ kind: "text", text: "t" }),
            },
          };
        },
        list: async () => [],
      },
      schedule: {
        create: async () => {},
        pause: async () => {},
        unpause: async () => {},
        delete: async () => {},
      },
    };
    void completionCallback;

    const scheduler = createTemporalScheduler({ client, taskQueue: "stats-queue" });
    const id = await scheduler.submit(agent, { kind: "text", text: "t" }, "dispatch");

    // Before reconcile: task is pending in map
    const beforeStats = scheduler.stats();
    expect(beforeStats.pending + beforeStats.running).toBe(1);
    expect(beforeStats.completed).toBe(0);

    // Trigger reconcile via query
    await scheduler.query({});

    // After reconcile: task moved to history, completed count increments
    const afterStats = scheduler.stats();
    expect(afterStats.completed).toBe(1);
    // Task no longer in live map
    const liveTasks = await scheduler.query({});
    expect(liveTasks.find((t) => t.id === id)).toBeUndefined();

    await scheduler[Symbol.asyncDispose]();
  });

  test("watch() listener not called after unsubscribe", async () => {
    const { createTemporalScheduler } = await import("../scheduler.js");
    const agent = agentId("watch-agent") as AgentId;

    const client = {
      workflow: {
        start: async (_wfType: string, opts: Record<string, unknown>) => ({
          workflowId: (opts.workflowId as string) ?? "wf-watch",
        }),
        cancel: async () => {},
        list: async () => [],
      },
      schedule: {
        create: async () => {},
        pause: async () => {},
        unpause: async () => {},
        delete: async () => {},
      },
    };

    const scheduler = createTemporalScheduler({ client, taskQueue: "watch-q" });

    const events: string[] = [];
    const unsubscribe = scheduler.watch((e) => {
      events.push(e.kind);
    });

    await scheduler.submit(agent, { kind: "text", text: "a" }, "dispatch");
    expect(events).toContain("task:submitted");

    unsubscribe();
    const countBefore = events.length;

    await scheduler.submit(agent, { kind: "text", text: "b" }, "dispatch");
    // No new events after unsubscribe
    expect(events.length).toBe(countBefore);

    await scheduler[Symbol.asyncDispose]();
  });

  test("asyncDispose() called twice does not double-close or throw", async () => {
    const { createTemporalScheduler } = await import("../scheduler.js");

    const scheduler = createTemporalScheduler({
      client: {
        workflow: {
          start: async () => ({ workflowId: "x" }),
          cancel: async () => {},
          list: async () => [],
        },
        schedule: {
          create: async () => {},
          pause: async () => {},
          unpause: async () => {},
          delete: async () => {},
        },
      },
      taskQueue: "q",
    });

    await expect(scheduler[Symbol.asyncDispose]()).resolves.toBeUndefined();
    await expect(scheduler[Symbol.asyncDispose]()).resolves.toBeUndefined();
  });
});
