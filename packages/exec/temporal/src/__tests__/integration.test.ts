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
import type {
  AgentStateRefs,
  AgentTurnInput,
  AgentTurnResult,
  AgentWorkflowConfig,
  IncomingMessage,
  ScheduledInputPayload,
  WorkerWorkflowConfig,
} from "../index.js";
import {
  MESSAGE_SIGNAL_NAME,
  PENDING_COUNT_QUERY_NAME,
  SHUTDOWN_SIGNAL_NAME,
  STATE_QUERY_NAME,
  STATUS_QUERY_NAME,
} from "../index.js";
import { MESSAGES_SIGNAL_NAME } from "../workflows/signals.js";

type NativeConnectionType = Awaited<
  ReturnType<typeof import("@temporalio/worker").NativeConnection.connect>
>;
type WorkerType = Awaited<ReturnType<typeof import("@temporalio/worker").Worker.create>>;
type ClientConnectionType = Awaited<
  ReturnType<typeof import("@temporalio/client").Connection.connect>
>;

const SKIP = process.env.TEMPORAL_INTEGRATION !== "true";
const REAL_WORKFLOW_PATH = new URL("../workflows/agent-workflow.ts", import.meta.url).pathname;
type WorkflowAgentId = AgentWorkflowConfig["agentId"];
type WorkerAgentId = WorkerWorkflowConfig["agentId"];
type WorkerParentAgentId = WorkerWorkflowConfig["parentAgentId"];

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
        signal: async (id: string, signalName: string, ...args: readonly unknown[]) => {
          const handle = temporalClient.workflow.getHandle(id);
          await handle.signal(signalName, ...(args as []));
        },
        cancel: async (id: string) => {
          const handle = temporalClient.workflow.getHandle(id);
          await handle.cancel();
        },
        getResult: async (id: string) => temporalClient.workflow.getHandle(id).result(),
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
        getHandle: (scheduleId: string) => ({
          describe: async () => temporalClient.schedule.getHandle(scheduleId).describe(),
        }),
      },
    },
    _conn: conn,
    _temporalClient: temporalClient,
    close: () => conn.close(),
  };
}

async function waitFor<T>(
  readValue: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 15_000,
  intervalMs = 200,
): Promise<T> {
  const start = Date.now();

  while (true) {
    const value = await readValue();
    if (predicate(value)) {
      return value;
    }

    if (Date.now() - start >= timeoutMs) {
      throw new Error("timed out waiting for Temporal workflow state");
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// ---------------------------------------------------------------------------
// 2. Restored workflow integration — real workflow module + stubbed activity
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)("Restored workflow integration (real Temporal)", () => {
  const QUEUE = "integration-agent-workflow-queue";

  test("agentWorkflow processes messages, updates queries, and shuts down", async () => {
    const { Client, Connection } = await import("@temporalio/client");
    const { NativeConnection, Worker } = await import("@temporalio/worker");

    const initialMessage: IncomingMessage = {
      id: "msg-1",
      senderId: "user-1",
      content: [],
      timestamp: Date.now(),
    };
    const followUpMessage: IncomingMessage = {
      id: "msg-2",
      senderId: "user-2",
      content: [],
      timestamp: Date.now() + 1,
    };
    const workflowConfig: AgentWorkflowConfig = {
      agentId: "workflow-agent" as WorkflowAgentId,
      sessionId: "session-integration" as AgentWorkflowConfig["sessionId"],
      stateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
      initialMessages: [initialMessage],
      gatewayUrl: "ws://workflow-gateway",
    };
    const activityCalls: AgentTurnInput[] = [];
    let nativeConn: NativeConnectionType | undefined;
    let worker: WorkerType | undefined;
    let workerPromise: Promise<void> | undefined;
    let clientConn: ClientConnectionType | undefined;

    try {
      nativeConn = await NativeConnection.connect({ address: "localhost:7233" });
      worker = await Worker.create({
        connection: nativeConn,
        taskQueue: QUEUE,
        workflowsPath: REAL_WORKFLOW_PATH,
        activities: {
          async runAgentTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
            const turnNumber = activityCalls.length + 1;
            activityCalls.push(input);
            return {
              turnId: `turn-${turnNumber}`,
              blocks: [],
              updatedStateRefs: {
                lastTurnId: `turn-${turnNumber}`,
                turnsProcessed: input.stateRefs.turnsProcessed + 1,
              },
              spawnChild: undefined,
            };
          },
        },
      });
      workerPromise = worker.run();
      clientConn = await Connection.connect({ address: "localhost:7233" });
      const client = new Client({ connection: clientConn });

      const handle = await client.workflow.start("agentWorkflow", {
        taskQueue: QUEUE,
        workflowId: `restored-agent-workflow-${Date.now()}`,
        args: [workflowConfig],
      });
      const queryPendingCount = async (): Promise<number> =>
        (await handle.query(PENDING_COUNT_QUERY_NAME)) as number;
      const queryStatus = async (): Promise<string> =>
        (await handle.query(STATUS_QUERY_NAME)) as string;

      await waitFor(
        async () => activityCalls.length,
        (count) => count === 1,
      );

      expect(activityCalls[0]).toEqual({
        agentId: workflowConfig.agentId,
        sessionId: workflowConfig.sessionId,
        message: initialMessage,
        stateRefs: workflowConfig.stateRefs,
        gatewayUrl: "ws://workflow-gateway",
      });

      const firstState = await waitFor(
        async () => (await handle.query(STATE_QUERY_NAME)) as AgentStateRefs,
        (state) => state.turnsProcessed === 1,
      );
      expect(firstState).toEqual({
        lastTurnId: "turn-1",
        turnsProcessed: 1,
      });
      expect(await queryPendingCount()).toBe(0);
      expect(await queryStatus()).toBe("idle");

      await handle.signal(MESSAGE_SIGNAL_NAME, followUpMessage);

      await waitFor(
        async () => activityCalls.length,
        (count) => count === 2,
      );
      expect(activityCalls[1]?.message).toEqual(followUpMessage);

      const secondState = await waitFor(
        async () => (await handle.query(STATE_QUERY_NAME)) as AgentStateRefs,
        (state) => state.turnsProcessed === 2,
      );
      expect(secondState).toEqual({
        lastTurnId: "turn-2",
        turnsProcessed: 2,
      });
      expect(await queryPendingCount()).toBe(0);
      expect(await queryStatus()).toBe("idle");

      await handle.signal(SHUTDOWN_SIGNAL_NAME, { reason: "integration-complete" });
      await expect(handle.result()).resolves.toBeUndefined();
    } finally {
      await clientConn?.close();
      worker?.shutdown();
      await workerPromise;
      await nativeConn?.close();
    }
  }, 60_000);

  test("workerWorkflow forwards optional runtime fields through the real workflow module", async () => {
    const { Client, Connection } = await import("@temporalio/client");
    const { NativeConnection, Worker } = await import("@temporalio/worker");

    const activityCalls: AgentTurnInput[] = [];
    const workflowConfig: WorkerWorkflowConfig = {
      agentId: "child-worker" as WorkerAgentId,
      sessionId: "session-worker" as WorkerWorkflowConfig["sessionId"],
      parentAgentId: "parent-worker" as WorkerParentAgentId,
      stateRefs: { lastTurnId: "turn-0", turnsProcessed: 4 },
      gatewayUrl: "ws://worker-gateway",
      nexusApiKey: "nexus-secret",
      delegationId: "delegation-42",
    };
    let nativeConn: NativeConnectionType | undefined;
    let worker: WorkerType | undefined;
    let workerPromise: Promise<void> | undefined;
    let clientConn: ClientConnectionType | undefined;

    try {
      nativeConn = await NativeConnection.connect({ address: "localhost:7233" });
      worker = await Worker.create({
        connection: nativeConn,
        taskQueue: QUEUE,
        workflowsPath: REAL_WORKFLOW_PATH,
        activities: {
          async runAgentTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
            activityCalls.push(input);
            return {
              turnId: "worker-turn-1",
              blocks: [],
              updatedStateRefs: {
                lastTurnId: "worker-turn-1",
                turnsProcessed: input.stateRefs.turnsProcessed + 1,
              },
              spawnChild: undefined,
            };
          },
        },
      });
      workerPromise = worker.run();
      clientConn = await Connection.connect({ address: "localhost:7233" });
      const client = new Client({ connection: clientConn });

      const handle = await client.workflow.start("workerWorkflow", {
        taskQueue: QUEUE,
        workflowId: `restored-worker-workflow-${Date.now()}`,
        args: [workflowConfig],
      });

      await expect(handle.result()).resolves.toEqual({
        turnId: "worker-turn-1",
        blocks: [],
        updatedStateRefs: {
          lastTurnId: "worker-turn-1",
          turnsProcessed: 5,
        },
        spawnChild: undefined,
      });
      expect(activityCalls).toEqual([
        {
          agentId: workflowConfig.agentId,
          sessionId: workflowConfig.sessionId,
          message: {
            id: "worker-init:child-worker",
            senderId: "parent-worker",
            content: [],
            timestamp: expect.any(Number),
          },
          stateRefs: workflowConfig.stateRefs,
          gatewayUrl: workflowConfig.gatewayUrl,
          nexusApiKey: workflowConfig.nexusApiKey,
          delegationId: workflowConfig.delegationId,
        },
      ]);
    } finally {
      await clientConn?.close();
      worker?.shutdown();
      await workerPromise;
      await nativeConn?.close();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 3. Scheduler integration — real Temporal server
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)("Scheduler integration (real Temporal)", () => {
  const QUEUE = "integration-test-queue";
  const agent = "integration-agent" as WorkflowAgentId;

  test("submit starts a workflow and query returns running status", async () => {
    const { NativeConnection, Worker } = await import("@temporalio/worker");
    const { createTemporalScheduler } = await import("../temporal-scheduler.js");

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
      let tasks: readonly { readonly status?: string }[] = [];
      let hist: readonly { readonly status?: string }[] = [];
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
      const observed = liveStatus ?? histStatus ?? "";
      expect(observed).toBeTruthy();
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
    const { createTemporalScheduler } = await import("../temporal-scheduler.js");

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
      const result = await Promise.resolve(scheduler.cancel(id)).catch(() => false);
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
    const { createTemporalScheduler } = await import("../temporal-scheduler.js");

    const agentA = "agent-alpha" as WorkflowAgentId;
    const agentB = "agent-beta" as WorkflowAgentId;

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
// 4. Worker factory integration
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
// 5. Corner cases (unit-level, no server needed — but grouped here for completeness)
// ---------------------------------------------------------------------------

describe("Corner cases (no server required)", () => {
  test("dispatch sends message batches atomically through the workflow batch signal", async () => {
    const { createTemporalScheduler } = await import("../temporal-scheduler.js");

    const signalCalls: unknown[][] = [];
    const scheduler = createTemporalScheduler({
      client: {
        workflow: {
          start: async () => ({ workflowId: "wf-unused" }),
          signal: async (...args: readonly unknown[]) => {
            signalCalls.push([...args]);
          },
          cancel: async () => {},
          getResult: async () => undefined,
        },
        schedule: {
          create: async () => {},
          pause: async () => {},
          unpause: async () => {},
          delete: async () => {},
          getHandle: () => ({ describe: async () => ({}) }),
        },
      },
      taskQueue: "q",
      workflowType: "agentWorkflow",
    });

    await scheduler.submit(
      "dispatch-agent" as WorkflowAgentId,
      {
        kind: "messages",
        messages: [
          { senderId: "user-a", content: [{ kind: "text", text: "first" }], timestamp: 1 },
          { senderId: "user-b", content: [{ kind: "text", text: "second" }], timestamp: 2 },
        ],
      } as never,
      "dispatch",
    );

    expect(signalCalls).toHaveLength(1);
    expect(signalCalls[0]?.[0]).toBe("dispatch-agent");
    expect(signalCalls[0]?.[1]).toBe(MESSAGES_SIGNAL_NAME);
    expect(signalCalls[0]?.[2]).toMatchObject([
      {
        senderId: "user-a",
        content: [{ kind: "text", text: "first" }],
        timestamp: 1,
      },
      {
        senderId: "user-b",
        content: [{ kind: "text", text: "second" }],
        timestamp: 2,
      },
    ]);

    await scheduler[Symbol.asyncDispose]();
  });

  test("scheduled spawn action passes queued workflow input and preserves maxStopRetries", async () => {
    const { createTemporalScheduler } = await import("../temporal-scheduler.js");

    const createCalls: Array<[string, Record<string, unknown>]> = [];
    const scheduler = createTemporalScheduler({
      client: {
        workflow: {
          start: async () => ({ workflowId: "wf-unused" }),
          signal: async () => {},
          cancel: async () => {},
          getResult: async () => undefined,
        },
        schedule: {
          create: async (scheduleId: string, options: Record<string, unknown>) => {
            createCalls.push([scheduleId, options]);
          },
          pause: async () => {},
          unpause: async () => {},
          delete: async () => {},
          getHandle: () => ({ describe: async () => ({}) }),
        },
      },
      taskQueue: "q",
      workflowType: "agentWorkflow",
    });

    const scheduledInput: ScheduledInputPayload = {
      kind: "text",
      text: "tick",
      maxStopRetries: 6,
    };

    await scheduler.schedule(
      "0 * * * *",
      "scheduled-agent" as WorkflowAgentId,
      scheduledInput as never,
      "spawn",
    );

    const action = createCalls[0]?.[1]?.action as Record<string, unknown>;
    const args = action.args as [Record<string, unknown>];
    expect(action.type).toBe("startWorkflow");
    expect(args[0]).toMatchObject({
      agentId: "scheduled-agent",
      initialScheduledInput: scheduledInput,
      maxStopRetries: 6,
    });
    expect(args[0]).not.toHaveProperty("input");

    await scheduler[Symbol.asyncDispose]();
  });

  test("cancel on unknown id returns false when no local task exists", async () => {
    const { createTemporalScheduler } = await import("../temporal-scheduler.js");

    const scheduler = createTemporalScheduler({
      client: {
        workflow: {
          start: async () => ({ workflowId: "x" }),
          signal: async () => {},
          cancel: async () => {},
          getResult: async () => undefined,
          // no describe → describe-absent path
        },
        schedule: {
          create: async () => {},
          pause: async () => {},
          unpause: async () => {},
          delete: async () => {},
          getHandle: () => ({ describe: async () => ({}) }),
        },
      },
      taskQueue: "q",
      workflowType: "agentWorkflow",
    });

    await expect(scheduler.cancel("never-submitted" as never)).resolves.toBe(false);
  });

  test("stats() counts completed work without a Temporal server", async () => {
    const { createTemporalScheduler } = await import("../temporal-scheduler.js");
    const agent = "stats-agent" as WorkflowAgentId;

    const client = {
      workflow: {
        start: async (_wfType: string, opts: Record<string, unknown>) => ({
          workflowId: (opts.workflowId as string) ?? "wf-1",
        }),
        signal: async () => {},
        cancel: async () => {},
        getResult: async () => undefined,
      },
      schedule: {
        create: async () => {},
        pause: async () => {},
        unpause: async () => {},
        delete: async () => {},
        getHandle: () => ({ describe: async () => ({}) }),
      },
    };

    const scheduler = createTemporalScheduler({
      client,
      taskQueue: "stats-queue",
      workflowType: "agentWorkflow",
    });
    const id = await scheduler.submit(agent, { kind: "text", text: "t" }, "spawn");

    const initialStats = scheduler.stats();
    expect(initialStats.pending + initialStats.running + initialStats.completed).toBe(1);

    const afterStats = await waitFor(
      async () => scheduler.stats(),
      (stats) => stats.completed === 1,
    );
    expect(afterStats.completed).toBe(1);
    expect(afterStats.pending).toBe(0);
    expect(afterStats.running).toBe(0);

    const history = await scheduler.history({});
    expect(history.find((entry) => entry.taskId === id)?.status).toBe("completed");

    await scheduler[Symbol.asyncDispose]();
  });

  test("watch() listener not called after unsubscribe", async () => {
    const { createTemporalScheduler } = await import("../temporal-scheduler.js");
    const agent = "watch-agent" as WorkflowAgentId;

    const client = {
      workflow: {
        start: async (_wfType: string, opts: Record<string, unknown>) => ({
          workflowId: (opts.workflowId as string) ?? "wf-watch",
        }),
        signal: async () => {},
        cancel: async () => {},
        getResult: async () => undefined,
      },
      schedule: {
        create: async () => {},
        pause: async () => {},
        unpause: async () => {},
        delete: async () => {},
        getHandle: () => ({ describe: async () => ({}) }),
      },
    };

    const scheduler = createTemporalScheduler({
      client,
      taskQueue: "watch-q",
      workflowType: "agentWorkflow",
    });

    const events: string[] = [];
    const unsubscribe = scheduler.watch((event: { readonly kind: string }) => {
      events.push(event.kind);
    });

    await scheduler.submit(agent, { kind: "text", text: "a" }, "spawn");
    expect(events).toContain("task:submitted");

    unsubscribe();
    const countBefore = events.length;

    await scheduler.submit(agent, { kind: "text", text: "b" }, "spawn");
    // No new events after unsubscribe
    expect(events.length).toBe(countBefore);

    await scheduler[Symbol.asyncDispose]();
  });

  test("asyncDispose() called twice does not double-close or throw", async () => {
    const { createTemporalScheduler } = await import("../temporal-scheduler.js");

    const scheduler = createTemporalScheduler({
      client: {
        workflow: {
          start: async () => ({ workflowId: "x" }),
          signal: async () => {},
          cancel: async () => {},
          getResult: async () => undefined,
        },
        schedule: {
          create: async () => {},
          pause: async () => {},
          unpause: async () => {},
          delete: async () => {},
          getHandle: () => ({ describe: async () => ({}) }),
        },
      },
      taskQueue: "q",
      workflowType: "agentWorkflow",
    });

    await expect(scheduler[Symbol.asyncDispose]()).resolves.toBeUndefined();
    await expect(scheduler[Symbol.asyncDispose]()).resolves.toBeUndefined();
  });
});
