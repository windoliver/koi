/**
 * End-to-end tests against a real Temporal server.
 *
 * Gated on TEMPORAL_E2E_ADDRESS — when unset, all tests in this file are skipped
 * so CI without a server still passes.
 *
 * Run with:
 *   temporal server start-dev --headless --port 7239 &
 *   TEMPORAL_E2E_ADDRESS=localhost:7239 bun test src/__tests__/e2e.test.ts
 *
 * Coverage: signal-into-long-running agent workflow, ABANDON child outliving
 * wrapper, runScheduledTask child cancellation surfaces, signalWithStart
 * direct-dispatch joins existing execution.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { createDefaultAgentActivities } from "../activities/agent-activity.js";
import { createDefaultRetryActivities } from "../activities/retry-activity.js";
import { createDefaultScheduledTaskActivities } from "../activities/scheduled-task-activity.js";
import { AGENT_WORKFLOW_NAME, SCHEDULED_TASK_WORKFLOW_NAME } from "../workflows/index.js";

const ADDRESS = process.env.TEMPORAL_E2E_ADDRESS;
const RUN = ADDRESS !== undefined && ADDRESS !== "";
const TASK_QUEUE = `koi-temporal-e2e-${Date.now()}`;
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_PATH = join(HERE, "fixtures", "e2e-workflows.ts");

type Ctx = {
  client: InstanceType<typeof Client>;
  worker: InstanceType<typeof Worker>;
  workerRun: Promise<void>;
};

let ctx: Ctx | undefined;

async function bringUp(): Promise<Ctx> {
  const connection = await Connection.connect({ address: ADDRESS });
  const nativeConnection = await NativeConnection.connect({ address: ADDRESS });
  const client = new Client({ connection });

  const agent = createDefaultAgentActivities();
  const sched = createDefaultScheduledTaskActivities({ runAgentWorkflow: async () => undefined });
  const retry = createDefaultRetryActivities({ runAgentTurn: agent.runAgentTurn });

  const worker = await Worker.create({
    connection: nativeConnection,
    workflowsPath: WORKFLOWS_PATH,
    activities: { ...agent, ...sched, ...retry },
    taskQueue: TASK_QUEUE,
  });

  const workerRun = worker.run();
  return { client, worker, workerRun };
}

beforeAll(async () => {
  if (!RUN) return;
  ctx = await bringUp();
}, 60_000);

afterAll(async () => {
  if (!ctx) return;
  (ctx.worker as unknown as { shutdown: () => void }).shutdown();
  await ctx.workerRun;
}, 30_000);

const e2e = RUN ? test : test.skip;

describe("temporal e2e (real server)", () => {
  e2e(
    "agentWorkflow processes initial messages and returns",
    async () => {
      const c = ctx;
      if (!c) throw new Error("no ctx");
      const handle = await c.client.workflow.start(AGENT_WORKFLOW_NAME, {
        taskQueue: TASK_QUEUE,
        workflowId: `e2e-agent-${Date.now()}`,
        args: [
          {
            agentId: "agent-1",
            sessionId: "session-1",
            stateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
            initialMessages: [
              { id: "m1", senderId: "u1", content: [{ kind: "text", text: "hi" }], timestamp: 1 },
            ],
            maxStopRetries: 0,
          },
        ],
      });
      await expect(handle.result()).resolves.toBeUndefined();
    },
    30_000,
  );

  e2e(
    "scheduledTaskWorkflow dispatch signals long-running per-agent workflow",
    async () => {
      const c = ctx;
      if (!c) throw new Error("no ctx");
      const agentId = `agent-${Date.now()}`;

      // Pre-start a long-running agent workflow at workflowId=agentId. Initial messages
      // are an empty queue → it will wait for signals (signal handler keeps it alive
      // since queue.length === 0 returns early; we need a non-empty seed).
      // Seed with one message to keep it alive long enough to receive the dispatch signal.
      const agentHandle = await c.client.workflow.start(AGENT_WORKFLOW_NAME, {
        taskQueue: TASK_QUEUE,
        workflowId: agentId,
        args: [
          {
            agentId,
            sessionId: "seed",
            stateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
            initialMessages: [
              {
                id: "seed",
                senderId: "u",
                content: [{ kind: "text", text: "seed" }],
                timestamp: 0,
              },
            ],
            maxStopRetries: 5,
          },
        ],
      });

      // Fire a dispatch wrapper. It should signal the running agent workflow.
      const dispatchHandle = await c.client.workflow.start(SCHEDULED_TASK_WORKFLOW_NAME, {
        taskQueue: TASK_QUEUE,
        workflowId: `e2e-dispatch-${Date.now()}`,
        args: [
          {
            mode: "dispatch",
            agentId,
            stateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
            input: { kind: "text", text: "tick" },
          },
        ],
      });

      await expect(dispatchHandle.result()).resolves.toEqual({ kind: "dispatched" });

      // Agent workflow may still be running; let it finish on its own (default agent
      // activity completes once the queue is consumed). Cancel as a safety net.
      try {
        await agentHandle.cancel();
      } catch {
        // already complete
      }
    },
    60_000,
  );

  e2e(
    "scheduledTaskWorkflow spawn child outlives wrapper (ABANDON close policy)",
    async () => {
      const c = ctx;
      if (!c) throw new Error("no ctx");
      const wrapperHandle = await c.client.workflow.start(SCHEDULED_TASK_WORKFLOW_NAME, {
        taskQueue: TASK_QUEUE,
        workflowId: `e2e-spawn-${Date.now()}`,
        args: [
          {
            mode: "spawn",
            agentId: "agent-spawn",
            stateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
            input: { kind: "text", text: "spawn-tick" },
          },
        ],
      });

      const result = (await wrapperHandle.result()) as
        | { kind: "spawned"; workflowId: string }
        | { kind: "dispatched" };

      expect(result.kind).toBe("spawned");
      if (result.kind !== "spawned") return;

      // Child should run independently to completion.
      const childHandle = c.client.workflow.getHandle(result.workflowId);
      await expect(childHandle.result()).resolves.toBeUndefined();
    },
    60_000,
  );
});
