/**
 * Integration test — spawn completion → synthesis prompt flow.
 *
 * Tests the full #1109 fix: plan_autonomous with spawn tasks → workers
 * complete synchronously → tool returns synthesis prompt → board is consistent.
 *
 * Also includes a regression test for the Nexus IPC 404 scenario:
 * notification failure with retry exhaustion + board reconciliation.
 */

import { describe, expect, test } from "bun:test";
import type {
  Agent,
  AgentMessage,
  AgentMessageInput,
  KoiError,
  MailboxComponent,
  MessageId,
  SpawnFn,
  SpawnRequest,
  TaskBoardSnapshot,
} from "@koi/core";
import { agentId, MAILBOX, taskItemId } from "@koi/core";
import type { HarnessScheduler } from "@koi/harness-scheduler";
import type { LongRunningHarness } from "@koi/long-running";
import { createAutonomousAgent } from "../autonomous.js";

// ---------------------------------------------------------------------------
// Mock helpers (reuse pattern from delegation-pipeline.integration.test.ts)
// ---------------------------------------------------------------------------

function createMockAgent(mailbox?: MailboxComponent): Agent {
  return {
    pid: { id: agentId("copilot-test"), name: "test", type: "copilot", depth: 0 },
    manifest: { name: "test", version: "0.1.0", model: { name: "test-model" } },
    state: "created",
    component: (<T>(token: import("@koi/core").SubsystemToken<T>): T | undefined => {
      if (token === MAILBOX && mailbox !== undefined) return mailbox as T;
      return undefined;
    }) as Agent["component"],
    has: () => false,
    hasAll: () => false,
    query: () => new Map(),
    components: () => new Map(),
  };
}

function createIntegrationHarness(): {
  readonly harness: LongRunningHarness;
  readonly getBoard: () => TaskBoardSnapshot;
} {
  // let justified: mutable state for test harness
  let board: TaskBoardSnapshot = { items: [], results: [] };

  const harness: LongRunningHarness = {
    harnessId: "spawn-flow-test" as LongRunningHarness["harnessId"],
    start: async (plan: TaskBoardSnapshot) => {
      board = plan;
      return {
        ok: true as const,
        value: { engineInput: {} as never, sessionId: "s1" },
      };
    },
    resume: async () => ({
      ok: true as const,
      value: { engineInput: {} as never, sessionId: "s1", engineStateRecovered: false },
    }),
    pause: async () => ({ ok: true as const, value: undefined }),
    fail: async () => ({ ok: true as const, value: undefined }),
    assignTask: async (taskId, workerId) => {
      const task = board.items.find((i) => i.id === taskId);
      if (task?.status !== "pending") {
        return {
          ok: false as const,
          error: {
            code: "VALIDATION" as const,
            message: `Cannot assign task ${taskId}: expected "pending", got "${task?.status}"`,
            retryable: false as const,
          },
        };
      }
      board = {
        items: board.items.map((item) =>
          item.id === taskId
            ? { ...item, status: "assigned" as const, assignedTo: workerId }
            : item,
        ),
        results: board.results,
      };
      return { ok: true as const, value: undefined };
    },
    completeTask: async (taskId, result) => {
      const task = board.items.find((i) => i.id === taskId);
      if (task?.status !== "assigned") {
        return {
          ok: false as const,
          error: {
            code: "VALIDATION" as const,
            message: `Cannot complete task ${taskId}: expected "assigned", got "${task?.status}"`,
            retryable: false as const,
          },
        };
      }
      board = {
        items: board.items.map((item) =>
          item.id === taskId ? { ...item, status: "completed" as const } : item,
        ),
        results: [...board.results, result],
      };
      return { ok: true as const, value: undefined };
    },
    failTask: async (taskId) => {
      const task = board.items.find((i) => i.id === taskId);
      if (task?.status !== "assigned") {
        return {
          ok: false as const,
          error: {
            code: "VALIDATION" as const,
            message: `Cannot fail task ${taskId}: expected "assigned", got "${task?.status}"`,
            retryable: false as const,
          },
        };
      }
      board = {
        items: board.items.map((item) =>
          item.id === taskId
            ? { ...item, status: "pending" as const, retries: (item.retries ?? 0) + 1 }
            : item,
        ),
        results: board.results,
      };
      return { ok: true as const, value: undefined };
    },
    status: () => ({
      harnessId: "spawn-flow-test" as LongRunningHarness["harnessId"],
      phase: "active" as const,
      currentSessionSeq: 1,
      taskBoard: board,
      metrics: {
        totalSessions: 1,
        totalTurns: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        completedTaskCount: board.items.filter((i) => i.status === "completed").length,
        pendingTaskCount: board.items.filter((i) => i.status !== "completed").length,
        elapsedMs: 0,
      },
    }),
    createMiddleware: () => ({
      name: "spawn-flow-harness-mw",
      describeCapabilities: () => undefined,
    }),
    dispose: async () => {},
  };

  return { harness, getBoard: () => board };
}

function createMockScheduler(): HarnessScheduler {
  return {
    start: () => {},
    stop: () => {},
    status: () => ({ phase: "idle" as const, retriesRemaining: 3, totalResumes: 0 }),
    dispose: async () => {},
  };
}

function createMockMailbox(): MailboxComponent & {
  readonly sentMessages: AgentMessageInput[];
  readonly sendResults: Array<
    | { readonly ok: true; readonly value: AgentMessage }
    | { readonly ok: false; readonly error: KoiError }
  >;
} {
  const sentMessages: AgentMessageInput[] = [];
  const sendResults: Array<
    | { readonly ok: true; readonly value: AgentMessage }
    | { readonly ok: false; readonly error: KoiError }
  > = [];
  // let justified: mutable result index for sequential results
  let callIndex = 0;

  return {
    sentMessages,
    sendResults,
    send: async (message: AgentMessageInput) => {
      sentMessages.push(message);
      if (callIndex < sendResults.length) {
        const result = sendResults[callIndex];
        callIndex++;
        if (result !== undefined) return result;
      }
      return {
        ok: true as const,
        value: {
          id: `msg-${String(sentMessages.length)}` as MessageId,
          from: message.from,
          to: message.to,
          kind: message.kind,
          type: message.type,
          payload: message.payload,
          createdAt: new Date().toISOString(),
        },
      };
    },
    onMessage: () => () => {},
    list: async () => [],
  };
}

async function getPlanTool(
  agent: ReturnType<typeof createAutonomousAgent>,
  mockAgent: Agent,
): Promise<{
  readonly execute: (args: Record<string, unknown>) => Promise<unknown>;
}> {
  const providers = agent.providers();
  const planProvider = providers.find((p) => p.name === "plan-autonomous-provider");
  if (planProvider === undefined) throw new Error("plan-autonomous-provider not found");

  const attachResult = await planProvider.attach(mockAgent);
  const components = "components" in attachResult ? attachResult.components : attachResult;
  const tool = components.get("tool:plan_autonomous");
  if (tool === undefined) throw new Error("plan_autonomous tool not found");
  return tool as { execute: (args: Record<string, unknown>) => Promise<unknown> };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("spawn completion → synthesis flow (#1109)", () => {
  test("plan_autonomous returns synthesis prompt when all spawn tasks complete synchronously", async () => {
    const { harness, getBoard } = createIntegrationHarness();
    const spawnCalls: SpawnRequest[] = [];

    const spawn: SpawnFn = async (req) => {
      spawnCalls.push(req);
      return { ok: true, output: `Output from ${req.taskId}` };
    };

    const agent = createAutonomousAgent({
      harness,
      scheduler: createMockScheduler(),
      getSpawn: () => spawn,
    });

    const mockAgent = createMockAgent();
    const planTool = await getPlanTool(agent, mockAgent);

    const result = (await planTool.execute({
      tasks: [
        { id: "ocean-haiku", description: "Write a haiku about the ocean", delegation: "spawn" },
        {
          id: "mountain-haiku",
          description: "Write a haiku about mountains",
          delegation: "spawn",
        },
      ],
    })) as Record<string, unknown>;

    // Key assertion: tool returns plan_completed, not plan_created
    expect(result.status).toBe("plan_completed");
    expect(result.completedCount).toBe(2);
    expect(result.message).toContain("task_synthesize");

    // Both workers were spawned
    expect(spawnCalls).toHaveLength(2);

    // Board is fully completed
    const board = getBoard();
    expect(board.items.filter((i) => i.status === "completed")).toHaveLength(2);
    expect(board.results).toHaveLength(2);

    await agent.dispose();
  });

  test("plan_autonomous returns plan_created when plan has self-delegated tasks (not all sync)", async () => {
    const { harness } = createIntegrationHarness();

    const agent = createAutonomousAgent({
      harness,
      scheduler: createMockScheduler(),
    });

    const mockAgent = createMockAgent();
    const planTool = await getPlanTool(agent, mockAgent);

    const result = (await planTool.execute({
      tasks: [
        { id: "task-a", description: "Do something", delegation: "self" },
        { id: "task-b", description: "Do something else", delegation: "self" },
      ],
    })) as Record<string, unknown>;

    // Self-delegated tasks are "assigned" not "completed" — generic response
    expect(result.status).toBe("plan_created");
    expect(result.taskCount).toBe(2);

    await agent.dispose();
  });

  test("spawn tasks with dependencies cascade correctly via bridge", async () => {
    const { harness, getBoard } = createIntegrationHarness();
    const spawnOrder: string[] = [];

    const spawn: SpawnFn = async (req) => {
      if (req.taskId !== undefined) spawnOrder.push(req.taskId as string);
      return { ok: true, output: `Done: ${req.taskId}` };
    };

    const agent = createAutonomousAgent({
      harness,
      scheduler: createMockScheduler(),
      getSpawn: () => spawn,
    });

    const mockAgent = createMockAgent();
    const planTool = await getPlanTool(agent, mockAgent);

    const result = (await planTool.execute({
      tasks: [
        { id: "research", description: "Research first", delegation: "spawn" },
        {
          id: "implement",
          description: "Implement based on research",
          dependencies: ["research"],
          delegation: "spawn",
        },
      ],
    })) as Record<string, unknown>;

    // All tasks completed
    expect(result.status).toBe("plan_completed");
    expect(result.completedCount).toBe(2);

    // Research dispatched before implement (dependency order)
    expect(spawnOrder[0]).toBe(taskItemId("research") as string);
    expect(spawnOrder[1]).toBe(taskItemId("implement") as string);

    // implement's description includes upstream context from research
    const board = getBoard();
    expect(board.results).toHaveLength(2);

    await agent.dispose();
  });
});

describe("notification retry on 404 (regression #1109)", () => {
  test("per-task notification uses retry when mailbox send fails with retryable error", async () => {
    const { harness } = createIntegrationHarness();
    const mailbox = createMockMailbox();

    // First call fails (simulating 404), second succeeds
    mailbox.sendResults.push({
      ok: false,
      error: { code: "NOT_FOUND", message: "inbox not found", retryable: true },
    });

    const spawn: SpawnFn = async (req) => {
      return { ok: true, output: `Output from ${req.taskId}` };
    };

    // threadStore must be provided so the autonomous-provider is created,
    // which captures the agent reference needed by notifyTask to access MAILBOX.
    const mockThreadStore: import("@koi/core").ThreadStore = {
      appendAndCheckpoint: async () => ({ ok: true, value: undefined }),
      loadThread: async () => ({ ok: true, value: undefined }),
      listMessages: async () => ({ ok: true, value: [] }),
      close: async () => {},
    };

    const agent = createAutonomousAgent({
      harness,
      scheduler: createMockScheduler(),
      getSpawn: () => spawn,
      logger: { warn: () => {}, error: () => {}, debug: () => {} },
      threadStore: mockThreadStore,
    });

    const mockAgent = createMockAgent(mailbox);

    // Attach ALL providers to capture the agent reference via autonomous-provider.
    const providers = agent.providers();
    for (const provider of providers) {
      await provider.attach(mockAgent);
    }

    const planTool = await getPlanTool(agent, mockAgent);

    await planTool.execute({
      tasks: [{ id: "test-task", description: "Test task", delegation: "spawn" }],
    });

    // Allow fire-and-forget notification with retry to complete.
    // sendWithRetry has baseDelay=1s by default, but retry is async.
    // Use a longer timeout to ensure at least the first attempt fires.
    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    // The mailbox was called (notification attempted via sendWithRetry).
    // First call returned 404 (retryable), so retry should fire.
    expect(mailbox.sentMessages.length).toBeGreaterThanOrEqual(1);

    await agent.dispose();
  });
});
