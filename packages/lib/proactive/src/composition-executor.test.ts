import { describe, expect, test } from "bun:test";
import {
  agentId,
  type CompositionPlan,
  type CompositionTrigger,
  type SchedulerComponent,
  scheduleId,
  taskId,
} from "../../../kernel/core/src/index.js";
import type {
  CheckpointSnapshot,
  CompositionCheckpointStore,
} from "./composition-checkpoint-store.js";
import {
  createCompositionExecutor,
  isPreCommitRejection,
  preCommitRejection,
} from "./composition-executor.js";

function recordingCheckpointStore() {
  const saves: CheckpointSnapshot[] = [];
  const deletes: string[] = [];
  const store: CompositionCheckpointStore = {
    save: (snapshot) => {
      saves.push(snapshot);
    },
    load: () => undefined,
    delete: (id) => {
      deletes.push(id);
    },
    list: () => [],
  };
  return { store, saves, deletes };
}

function trigger(): CompositionTrigger {
  return {
    id: "trigger-1",
    source: "governance",
    confidence: 1,
    moment: {
      kind: "threshold_crossed",
      sensor: "error_rate",
      value: 1,
      limit: 0.2,
      direction: "above",
    },
    suggestedCapabilities: ["notify_user"],
    context: {},
    emittedAt: 1,
  };
}

function schedulerStub() {
  const calls: { submit: unknown[]; schedule: unknown[] } = { submit: [], schedule: [] };
  const scheduler: SchedulerComponent = {
    async submit(...args: unknown[]) {
      calls.submit.push(args);
      return taskId("task-1");
    },
    async cancel() {
      return true;
    },
    async schedule(...args: unknown[]) {
      calls.schedule.push(args);
      return scheduleId("schedule-1");
    },
    async unschedule() {
      return true;
    },
    async pause() {
      return true;
    },
    async resume() {
      return true;
    },
    async query() {
      return [];
    },
    async stats() {
      return {
        pending: 0,
        running: 0,
        completed: 0,
        failed: 0,
        deadLettered: 0,
        activeSchedules: 0,
        pausedSchedules: 0,
      };
    },
    async history() {
      return [];
    },
  };

  return { scheduler, calls };
}

function failingSubmitSchedulerStub() {
  const { scheduler, calls } = schedulerStub();
  const failingScheduler: SchedulerComponent = {
    ...scheduler,
    async submit(...args: unknown[]) {
      calls.submit.push(args);
      throw new Error("submit failed");
    },
  };
  return { scheduler: failingScheduler, calls };
}

function inMemoryExecutionLog() {
  const store = new Map<string, { kind: "pending" } | { kind: "complete"; output: unknown }>();
  return {
    log: {
      claim: (key: string) => {
        const existing = store.get(key);
        if (existing) return existing;
        store.set(key, { kind: "pending" });
        return { kind: "claimed" } as const;
      },
      record: (key: string, output: unknown) => {
        store.set(key, { kind: "complete", output });
      },
      release: (key: string) => {
        store.delete(key);
      },
    },
    store,
  };
}

function failingScheduleSchedulerStub() {
  const { scheduler, calls } = schedulerStub();
  const failingScheduler: SchedulerComponent = {
    ...scheduler,
    async schedule(...args: unknown[]) {
      calls.schedule.push(args);
      throw new Error("schedule failed");
    },
  };
  return { scheduler: failingScheduler, calls };
}

describe("createCompositionExecutor", () => {
  test("returns requires_approval without executing steps", async () => {
    const { scheduler, calls } = schedulerStub();
    const notifications: unknown[] = [];
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async (notification) => {
        notifications.push(notification);
        return { delivered: true };
      },
      executionLog: inMemoryExecutionLog().log,
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
      triggerEmittedAt: 1,
      steps: [{ kind: "notify_user", channel: "inbox", message: "hello", priority: "high" }],
      estimatedCost: 1,
      requiresApproval: true,
    };

    const result = await executor.execute(trigger(), plan);

    expect(result.status).toBe("requires_approval");
    expect(result.executedCount).toBe(0);
    expect(result.stepResults).toEqual([]);
    expect(result.error).toMatchObject({
      code: "APPROVAL_REQUIRED",
    });
    expect(calls.submit).toHaveLength(0);
    expect(calls.schedule).toHaveLength(0);
    expect(notifications).toHaveLength(0);
  });

  test("fails when plan.triggerId does not match execute trigger", async () => {
    const { scheduler, calls } = schedulerStub();
    const notifications: unknown[] = [];
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async (notification) => {
        notifications.push(notification);
        return { delivered: true };
      },
      executionLog: inMemoryExecutionLog().log,
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-other",
      triggerEmittedAt: 1,
      steps: [{ kind: "notify_user", channel: "inbox", message: "hello", priority: "high" }],
      estimatedCost: 1,
      requiresApproval: false,
    };

    const result = await executor.execute(trigger(), plan);

    expect(result.status).toBe("failed");
    expect(result.executedCount).toBe(0);
    expect(result.stepResults).toEqual([]);
    expect(result.error).toMatchObject({
      code: "INVALID_PLAN",
    });
    expect(calls.submit).toHaveLength(0);
    expect(calls.schedule).toHaveLength(0);
    expect(notifications).toHaveLength(0);
  });

  test("executes submit_task for the attached agent and records output", async () => {
    const { scheduler, calls } = schedulerStub();
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async () => ({ delivered: true }),
      executionLog: inMemoryExecutionLog().log,
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
      triggerEmittedAt: 1,
      steps: [
        {
          kind: "submit_task",
          agentId: agentId("agent-1"),
          mode: "dispatch",
          input: { kind: "text", text: "follow up" },
          taskOptions: { delayMs: 5 },
        },
      ],
      estimatedCost: 1,
      requiresApproval: false,
    };

    const result = await executor.execute(trigger(), plan);

    expect(result.status).toBe("executed");
    expect(result.executedCount).toBe(1);
    expect(result.stepResults[0]?.status).toBe("executed");
    expect(result.stepResults[0]?.output).toBe(taskId("task-1"));
    expect(calls.submit).toHaveLength(1);
    expect(calls.submit[0]).toEqual([
      { kind: "text", text: "follow up" },
      "dispatch",
      { delayMs: 5, idempotencyKey: expect.stringMatching(/^cmp-[0-9a-f]{32}$/) },
    ]);
  });

  test("executes create_schedule for the attached agent and records output", async () => {
    const { scheduler, calls } = schedulerStub();
    const { log } = inMemoryExecutionLog();
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async () => ({ delivered: true }),
      executionLog: log,
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
      triggerEmittedAt: 1,
      steps: [
        {
          kind: "create_schedule",
          expression: "0 9 * * *",
          agentId: agentId("agent-1"),
          mode: "spawn",
          input: { kind: "text", text: "daily check-in" },
          timezone: "America/Los_Angeles",
        },
      ],
      estimatedCost: 1,
      requiresApproval: false,
    };

    const result = await executor.execute(trigger(), plan);

    expect(result.status).toBe("executed");
    expect(result.executedCount).toBe(1);
    expect(result.stepResults[0]?.status).toBe("executed");
    expect(result.stepResults[0]?.output).toBe(scheduleId("schedule-1"));
    expect(calls.schedule).toHaveLength(1);
    // schedule() must NOT receive idempotencyKey — Temporal scheduler rejects it.
    expect(calls.schedule[0]).toEqual([
      "0 9 * * *",
      { kind: "text", text: "daily check-in" },
      "spawn",
      { timezone: "America/Los_Angeles" },
    ]);
  });

  test("executes notify_user and records output", async () => {
    const { scheduler } = schedulerStub();
    const notifications: unknown[] = [];
    const { log } = inMemoryExecutionLog();
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async (notification) => {
        notifications.push(notification);
        return { delivered: true };
      },
      executionLog: log,
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
      triggerEmittedAt: 1,
      steps: [{ kind: "notify_user", channel: "inbox", message: "hello", priority: "normal" }],
      estimatedCost: 1,
      requiresApproval: false,
    };

    const result = await executor.execute(trigger(), plan);

    expect(result.status).toBe("executed");
    expect(result.executedCount).toBe(1);
    expect(result.stepResults[0]?.status).toBe("executed");
    expect(result.stepResults[0]?.output).toEqual({ delivered: true });
    expect(notifications).toEqual([
      {
        channel: "inbox",
        message: "hello",
        priority: "normal",
        idempotencyKey: expect.stringMatching(/^cmp-[0-9a-f]{32}$/),
      },
    ]);
  });

  test("fails when submit_task targets a different agentId than the attached scheduler", async () => {
    const { scheduler, calls } = schedulerStub();
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async () => ({ delivered: true }),
      executionLog: inMemoryExecutionLog().log,
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
      triggerEmittedAt: 1,
      steps: [
        {
          kind: "submit_task",
          agentId: agentId("agent-2"),
          mode: "dispatch",
          input: { kind: "text", text: "follow up" },
        },
      ],
      estimatedCost: 1,
      requiresApproval: false,
    };

    const result = await executor.execute(trigger(), plan);

    expect(result.status).toBe("failed");
    expect(result.executedCount).toBe(0);
    expect(result.error).toMatchObject({
      code: "INVALID_PLAN",
      stepKind: "submit_task",
    });
    expect(calls.submit).toHaveLength(0);
  });

  test("returns failed when scheduler.submit throws", async () => {
    const { scheduler, calls } = failingSubmitSchedulerStub();
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async () => ({ delivered: true }),
      executionLog: inMemoryExecutionLog().log,
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
      triggerEmittedAt: 1,
      steps: [
        {
          kind: "submit_task",
          agentId: agentId("agent-1"),
          mode: "dispatch",
          input: { kind: "text", text: "follow up" },
        },
      ],
      estimatedCost: 1,
      requiresApproval: false,
    };

    const result = await executor.execute(trigger(), plan);

    expect(result.status).toBe("failed");
    expect(result.executedCount).toBe(0);
    expect(result.error).toMatchObject({
      code: "STEP_FAILED",
      stepKind: "submit_task",
    });
    expect(result.stepResults[0]?.status).toBe("failed");
    expect(calls.submit).toHaveLength(1);
  });

  test("fails when create_schedule targets a different agentId than the attached scheduler", async () => {
    const { scheduler, calls } = schedulerStub();
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async () => ({ delivered: true }),
      executionLog: inMemoryExecutionLog().log,
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
      triggerEmittedAt: 1,
      steps: [
        {
          kind: "create_schedule",
          expression: "0 9 * * *",
          agentId: agentId("agent-2"),
          mode: "spawn",
          input: { kind: "text", text: "daily check-in" },
        },
      ],
      estimatedCost: 1,
      requiresApproval: false,
    };

    const result = await executor.execute(trigger(), plan);

    expect(result.status).toBe("failed");
    expect(result.executedCount).toBe(0);
    expect(result.error).toMatchObject({
      code: "INVALID_PLAN",
      stepKind: "create_schedule",
    });
    expect(calls.schedule).toHaveLength(0);
  });

  test("returns failed after a successful prefix when scheduler.schedule throws", async () => {
    const { scheduler, calls } = failingScheduleSchedulerStub();
    const notifications: unknown[] = [];
    const { log } = inMemoryExecutionLog();
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async (notification) => {
        notifications.push(notification);
        return { delivered: true };
      },
      executionLog: log,
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
      triggerEmittedAt: 1,
      steps: [
        { kind: "notify_user", channel: "inbox", message: "hello", priority: "normal" },
        {
          kind: "create_schedule",
          expression: "0 9 * * *",
          agentId: agentId("agent-1"),
          mode: "spawn",
          input: { kind: "text", text: "daily check-in" },
        },
      ],
      estimatedCost: 2,
      requiresApproval: false,
    };

    const result = await executor.execute(trigger(), plan);

    expect(result.status).toBe("failed");
    expect(result.executedCount).toBe(1);
    expect(result.error).toMatchObject({
      code: "STEP_FAILED",
      stepKind: "create_schedule",
    });
    expect(result.stepResults[0]?.status).toBe("executed");
    expect(result.stepResults[1]?.status).toBe("failed");
    expect(calls.schedule).toHaveLength(1);
    expect(notifications).toHaveLength(1);
  });

  test("stops on unsupported spawn_agent after executed prefix", async () => {
    const { scheduler } = schedulerStub();
    const notifications: unknown[] = [];
    const { log } = inMemoryExecutionLog();
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async (notification) => {
        notifications.push(notification);
        return { delivered: true };
      },
      executionLog: log,
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
      triggerEmittedAt: 1,
      steps: [
        { kind: "notify_user", channel: "inbox", message: "hello", priority: "normal" },
        {
          kind: "spawn_agent",
          agentType: "researcher",
          input: { kind: "text", text: "investigate" },
          delivery: { kind: "deferred" },
        },
      ],
      estimatedCost: 3,
      requiresApproval: false,
    };

    const result = await executor.execute(trigger(), plan);

    expect(result.status).toBe("unsupported");
    expect(result.executedCount).toBe(1);
    expect(result.stepResults[0]?.status).toBe("executed");
    expect(result.stepResults[1]?.status).toBe("unsupported");
    expect(result.error).toMatchObject({
      code: "STEP_UNSUPPORTED",
      stepKind: "spawn_agent",
    });
    expect(result.stepResults[1]?.error?.code).toBe("STEP_UNSUPPORTED");
    expect(notifications).toHaveLength(1);
  });

  test("executes spawn_agent through injected handler with executionLog dedupe", async () => {
    const { scheduler } = schedulerStub();
    const spawnCalls: { request: unknown }[] = [];
    const { log, store } = inMemoryExecutionLog();
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async () => ({ delivered: true }),
      executionLog: log,
      spawn: async (request) => {
        spawnCalls.push({ request });
        return { spawnedId: "spawn-1" };
      },
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
      triggerEmittedAt: 1,
      steps: [
        {
          kind: "spawn_agent",
          agentType: "researcher",
          input: { kind: "text", text: "investigate" },
          delivery: { kind: "deferred" },
        },
      ],
      estimatedCost: 1,
      requiresApproval: false,
    };

    const first = await executor.execute(trigger(), plan);
    expect(first.status).toBe("executed");
    expect(first.stepResults[0]?.output).toEqual({ spawnedId: "spawn-1" });
    expect(spawnCalls).toHaveLength(1);
    expect((spawnCalls[0]?.request as { idempotencyKey?: string })?.idempotencyKey).toMatch(
      /^cmp-[0-9a-f]{32}$/,
    );

    // Replay short-circuits via executionLog.
    const second = await executor.execute(trigger(), plan);
    expect(second.status).toBe("executed");
    expect(spawnCalls).toHaveLength(1);
    expect(store.size).toBe(1);
  });

  test("executes tool_call through injected handler", async () => {
    const { scheduler } = schedulerStub();
    const toolCalls: { name: string; input: unknown; key: string }[] = [];
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async () => ({ delivered: true }),
      executionLog: inMemoryExecutionLog().log,
      toolCall: async (req) => {
        toolCalls.push({ name: req.toolName, input: req.input, key: req.idempotencyKey });
        return { result: 42 };
      },
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
      triggerEmittedAt: 1,
      steps: [{ kind: "tool_call", toolName: "calc.add", input: { a: 1, b: 2 } }],
      estimatedCost: 1,
      requiresApproval: false,
    };

    const result = await executor.execute(trigger(), plan);
    expect(result.status).toBe("executed");
    expect(result.stepResults[0]?.output).toEqual({ result: 42 });
    expect(toolCalls[0]?.name).toBe("calc.add");
    expect(toolCalls[0]?.key).toMatch(/^cmp-[0-9a-f]{32}$/);
  });

  test("stops on unsupported forge_skill", async () => {
    const { scheduler } = schedulerStub();
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async () => ({ delivered: true }),
      executionLog: inMemoryExecutionLog().log,
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
      triggerEmittedAt: 1,
      steps: [
        {
          kind: "forge_skill",
          demand: {
            id: "forge-demand-1",
            kind: "forge_demand",
            trigger: {
              kind: "capability_gap",
              requiredCapability: "forge_skill",
            },
            confidence: 0.8,
            suggestedBrickKind: "skill",
            context: {
              failureCount: 1,
              failedToolCalls: ["forge_skill"],
              taskDescription: "missing skill",
            },
            emittedAt: 1,
          },
        },
      ],
      estimatedCost: 2,
      requiresApproval: false,
    };

    const result = await executor.execute(trigger(), plan);

    expect(result.status).toBe("unsupported");
    expect(result.executedCount).toBe(0);
    expect(result.error).toMatchObject({
      code: "STEP_UNSUPPORTED",
      stepKind: "forge_skill",
    });
    expect(result.stepResults[0]?.status).toBe("unsupported");
  });

  test("stops on unsupported tool_call after executed prefix", async () => {
    const { scheduler } = schedulerStub();
    const notifications: unknown[] = [];
    const { log } = inMemoryExecutionLog();
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async (notification) => {
        notifications.push(notification);
        return { delivered: true };
      },
      executionLog: log,
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
      triggerEmittedAt: 1,
      steps: [
        { kind: "notify_user", channel: "inbox", message: "hello", priority: "normal" },
        { kind: "tool_call", toolName: "search", input: { query: "koi" } },
      ],
      estimatedCost: 2,
      requiresApproval: false,
    };

    const result = await executor.execute(trigger(), plan);

    expect(result.status).toBe("unsupported");
    expect(result.executedCount).toBe(1);
    expect(result.error).toMatchObject({
      code: "STEP_UNSUPPORTED",
      stepKind: "tool_call",
    });
    expect(result.stepResults[0]?.status).toBe("executed");
    expect(result.stepResults[1]?.status).toBe("unsupported");
    expect(notifications).toHaveLength(1);
  });

  test("returns failed when notify_user throws", async () => {
    const { scheduler } = schedulerStub();
    const { log } = inMemoryExecutionLog();
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async () => {
        throw new Error("notify failed");
      },
      executionLog: log,
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
      triggerEmittedAt: 1,
      steps: [{ kind: "notify_user", channel: "inbox", message: "hello", priority: "normal" }],
      estimatedCost: 1,
      requiresApproval: false,
    };

    const result = await executor.execute(trigger(), plan);

    expect(result.status).toBe("failed");
    expect(result.executedCount).toBe(0);
    expect(result.error).toMatchObject({
      code: "STEP_FAILED",
      stepKind: "notify_user",
    });
    expect(result.stepResults[0]?.status).toBe("failed");
  });

  test("returns failed after a successful prefix when a later notify_user throws", async () => {
    const { scheduler } = schedulerStub();
    let notifyCalls = 0;
    const { log } = inMemoryExecutionLog();
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async () => {
        notifyCalls += 1;
        if (notifyCalls === 2) throw new Error("notify failed later");
        return { delivered: true };
      },
      executionLog: log,
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
      triggerEmittedAt: 1,
      steps: [
        { kind: "notify_user", channel: "inbox", message: "first", priority: "normal" },
        { kind: "notify_user", channel: "inbox", message: "second", priority: "high" },
      ],
      estimatedCost: 2,
      requiresApproval: false,
    };

    const result = await executor.execute(trigger(), plan);

    expect(result.status).toBe("failed");
    expect(result.executedCount).toBe(1);
    expect(result.error).toMatchObject({
      code: "STEP_FAILED",
      stepKind: "notify_user",
    });
    expect(result.stepResults[0]?.status).toBe("executed");
    expect(result.stepResults[1]?.status).toBe("failed");
  });

  test("re-executing the same trigger+plan reuses idempotency keys (retry-safe)", async () => {
    const { scheduler, calls } = schedulerStub();
    const notifications: unknown[] = [];
    const { log } = inMemoryExecutionLog();
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async (notification) => {
        notifications.push(notification);
        return { delivered: true };
      },
      executionLog: log,
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
      triggerEmittedAt: 1,
      steps: [
        {
          kind: "submit_task",
          agentId: agentId("agent-1"),
          mode: "dispatch",
          input: { kind: "text", text: "retry me" },
        },
        {
          kind: "create_schedule",
          expression: "0 9 * * *",
          agentId: agentId("agent-1"),
          mode: "spawn",
          input: { kind: "text", text: "daily" },
        },
        { kind: "notify_user", channel: "inbox", message: "hi", priority: "normal" },
      ],
      estimatedCost: 3,
      requiresApproval: false,
    };

    await executor.execute(trigger(), plan);
    await executor.execute(trigger(), plan);

    // schedule() must NOT carry idempotencyKey — backend rejects it.
    const scheduleOpts0 = (calls.schedule[0] as readonly unknown[])[3] as Record<string, unknown>;
    expect(scheduleOpts0).not.toHaveProperty("idempotencyKey");

    // All three step kinds MUST short-circuit on replay via the
    // executionLog — exactly one underlying side-effect call each across
    // both executions, even though both runs report the steps as executed.
    expect(calls.submit).toHaveLength(1);
    expect(calls.schedule).toHaveLength(1);
    expect(notifications).toHaveLength(1);

    const submitKey = (calls.submit[0] as readonly unknown[])[2] as { idempotencyKey: string };
    expect(submitKey.idempotencyKey).not.toContain(":"); // Temporal-safe.
  });

  test("create_schedule forwards taskOptions to the scheduler verbatim", async () => {
    const { scheduler, calls } = schedulerStub();
    const { log } = inMemoryExecutionLog();
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async () => ({ delivered: true }),
      executionLog: log,
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
      triggerEmittedAt: 1,
      steps: [
        {
          kind: "create_schedule",
          expression: "0 9 * * *",
          agentId: agentId("agent-1"),
          mode: "spawn",
          input: { kind: "text", text: "daily" },
          taskOptions: { maxRetries: 2, priority: 5 },
          timezone: "UTC",
        },
      ],
      estimatedCost: 1,
      requiresApproval: false,
    };

    const result = await executor.execute(trigger(), plan);

    // Backend-specific option support is the scheduler's responsibility,
    // not the executor's. Schedulers that cannot honor an option must
    // throw preCommitRejection() (covered by the next test).
    expect(result.status).toBe("executed");
    expect(calls.schedule).toHaveLength(1);
    const opts = (calls.schedule[0] as readonly unknown[])[3] as Record<string, unknown>;
    expect(opts).toMatchObject({ maxRetries: 2, priority: 5, timezone: "UTC" });
  });

  test("scheduler preCommitRejection releases the claim so retries are unblocked", async () => {
    const { scheduler: base } = schedulerStub();
    const rejecting: SchedulerComponent = {
      ...base,
      async schedule() {
        throw preCommitRejection("backend cannot honor maxRetries on schedule()");
      },
    };
    const { log, store } = inMemoryExecutionLog();
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler: rejecting,
      notify: async () => ({ delivered: true }),
      executionLog: log,
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
      triggerEmittedAt: 1,
      steps: [
        {
          kind: "create_schedule",
          expression: "0 9 * * *",
          agentId: agentId("agent-1"),
          mode: "spawn",
          input: { kind: "text", text: "daily" },
          taskOptions: { maxRetries: 2 },
        },
      ],
      estimatedCost: 1,
      requiresApproval: false,
    };

    const result = await executor.execute(trigger(), plan);

    expect(result.status).toBe("failed");
    // Claim was released because the scheduler signaled pre-commit
    // rejection — the log is clean and an operator/caller can retry
    // without manual reconciliation.
    expect(store.size).toBe(0);
  });

  test("submit_task preCommitRejection releases the claim so corrected retry is unblocked", async () => {
    const { scheduler: base, calls } = schedulerStub();
    let attempt = 0;
    const rejectingThenAccepting: SchedulerComponent = {
      ...base,
      async submit(...args: Parameters<SchedulerComponent["submit"]>) {
        attempt += 1;
        if (attempt === 1) {
          throw preCommitRejection("submit() does not enforce timeoutMs or maxRetries.");
        }
        return base.submit(...args);
      },
    };
    const { log, store } = inMemoryExecutionLog();
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler: rejectingThenAccepting,
      notify: async () => ({ delivered: true }),
      executionLog: log,
    });
    const planBad: CompositionPlan = {
      triggerId: "trigger-1",
      triggerEmittedAt: 1,
      steps: [
        {
          kind: "submit_task",
          agentId: agentId("agent-1"),
          mode: "dispatch",
          input: { kind: "text", text: "x" },
          taskOptions: { timeoutMs: 5000 },
        },
      ],
      estimatedCost: 1,
      requiresApproval: false,
    };
    const planGood: CompositionPlan = {
      ...planBad,
      steps: [
        {
          kind: "submit_task",
          agentId: agentId("agent-1"),
          mode: "dispatch",
          input: { kind: "text", text: "x" },
        },
      ],
    };

    const failed = await executor.execute(trigger(), planBad);
    expect(failed.status).toBe("failed");
    // Claim released — store is clean and corrected retry is unblocked.
    expect(store.size).toBe(0);

    const ok = await executor.execute(trigger(), planGood);
    expect(ok.status).toBe("executed");
    expect(calls.submit).toHaveLength(1);
  });

  test("create_schedule fails closed when prior attempt is pending (partial-failure recovery)", async () => {
    const { scheduler, calls } = schedulerStub();
    const { log, store } = inMemoryExecutionLog();
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async () => ({ delivered: true }),
      executionLog: log,
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
      triggerEmittedAt: 1,
      steps: [
        {
          kind: "create_schedule",
          expression: "0 9 * * *",
          agentId: agentId("agent-1"),
          mode: "spawn",
          input: { kind: "text", text: "daily" },
        },
      ],
      estimatedCost: 1,
      requiresApproval: false,
    };

    // Simulate a prior attempt that scheduled but never recorded.
    const stepKey = Array.from(store.keys()).at(0); // none yet — derive via run
    expect(stepKey).toBeUndefined();
    // Run once normally to learn the key, then poison it back to pending.
    await executor.execute(trigger(), plan);
    const liveKey = Array.from(store.keys())[0]!;
    store.set(liveKey, { kind: "pending" });

    const before = calls.schedule.length;
    const result = await executor.execute(trigger(), plan);

    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ code: "STEP_FAILED", stepKind: "create_schedule" });
    // No additional schedule() call on the retry.
    expect(calls.schedule).toHaveLength(before);
  });

  test("identical plan with different trigger emittedAt produces different keys", async () => {
    const { scheduler, calls } = schedulerStub();
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async () => ({ delivered: true }),
      executionLog: inMemoryExecutionLog().log,
    });
    const stepDef = {
      kind: "submit_task",
      agentId: agentId("agent-1"),
      mode: "dispatch",
      input: { kind: "text", text: "x" },
    } as const;
    const planA: CompositionPlan = {
      triggerId: "trigger-1",
      triggerEmittedAt: 1,
      steps: [stepDef],
      estimatedCost: 1,
      requiresApproval: false,
    };
    const planB: CompositionPlan = { ...planA, triggerEmittedAt: 2 };

    await executor.execute({ ...trigger(), emittedAt: 1 }, planA);
    await executor.execute({ ...trigger(), emittedAt: 2 }, planB);

    const key0 = (calls.submit[0] as readonly unknown[])[2] as { idempotencyKey: string };
    const key1 = (calls.submit[1] as readonly unknown[])[2] as { idempotencyKey: string };
    expect(key0.idempotencyKey).not.toBe(key1.idempotencyKey);
  });

  test("re-planning with different content at the same index produces a different key", async () => {
    const { scheduler, calls } = schedulerStub();
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async () => ({ delivered: true }),
      executionLog: inMemoryExecutionLog().log,
    });
    const planA: CompositionPlan = {
      triggerId: "trigger-1",
      triggerEmittedAt: 1,
      steps: [
        {
          kind: "submit_task",
          agentId: agentId("agent-1"),
          mode: "dispatch",
          input: { kind: "text", text: "version A" },
        },
      ],
      estimatedCost: 1,
      requiresApproval: false,
    };
    const planB: CompositionPlan = {
      ...planA,
      steps: [
        {
          kind: "submit_task",
          agentId: agentId("agent-1"),
          mode: "dispatch",
          input: { kind: "text", text: "version B" },
        },
      ],
    };

    await executor.execute(trigger(), planA);
    await executor.execute(trigger(), planB);

    const keyA = (calls.submit[0] as readonly unknown[])[2] as { idempotencyKey: string };
    const keyB = (calls.submit[1] as readonly unknown[])[2] as { idempotencyKey: string };
    expect(keyA.idempotencyKey).not.toBe(keyB.idempotencyKey);
  });

  test("ambiguous schedule() throw leaves the claim pending and exposes the key for reconciliation", async () => {
    const { calls } = schedulerStub();
    const { log, store } = inMemoryExecutionLog();
    const failingScheduler: SchedulerComponent = {
      async submit(...args: unknown[]) {
        calls.submit.push(args);
        return taskId("task-1");
      },
      async cancel() {
        return true;
      },
      async schedule(...args: unknown[]) {
        calls.schedule.push(args);
        throw new Error("ambiguous: timeout");
      },
      async unschedule() {
        return true;
      },
      async pause() {
        return true;
      },
      async resume() {
        return true;
      },
      async query() {
        return [];
      },
      async stats() {
        return {
          pending: 0,
          running: 0,
          completed: 0,
          failed: 0,
          deadLettered: 0,
          activeSchedules: 0,
          pausedSchedules: 0,
        };
      },
      async history() {
        return [];
      },
    };
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler: failingScheduler,
      notify: async () => ({ delivered: true }),
      executionLog: log,
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
      triggerEmittedAt: 1,
      steps: [
        {
          kind: "create_schedule",
          expression: "0 9 * * *",
          agentId: agentId("agent-1"),
          mode: "spawn",
          input: { kind: "text", text: "daily" },
        },
      ],
      estimatedCost: 1,
      requiresApproval: false,
    };

    // First attempt: schedule throws. Claim is left pending — we cannot
    // tell whether the schedule was actually created.
    const first = await executor.execute(trigger(), plan);
    expect(first.status).toBe("failed");
    expect(store.size).toBe(1);
    const [pendingKey] = Array.from(store.keys());
    expect(store.get(pendingKey!)).toEqual({ kind: "pending" });

    // Second attempt: must fail closed and expose the idempotency key so an
    // operator can manually reconcile.
    const second = await executor.execute(trigger(), plan);
    expect(second.status).toBe("failed");
    expect(second.error).toMatchObject({
      code: "STEP_FAILED",
      stepKind: "create_schedule",
      idempotencyKey: pendingKey,
    });
    // No second schedule() call — the pending guard short-circuits.
    expect(calls.schedule).toHaveLength(1);

    // After operator reconciliation (release), retry can succeed.
    log.release(pendingKey!);
    expect(store.size).toBe(0);
  });

  test("create_schedule pre-commit rejection releases the claim so retry can succeed", async () => {
    const { calls } = schedulerStub();
    const { log, store } = inMemoryExecutionLog();
    let attempt = 0;
    const validatingScheduler: SchedulerComponent = {
      async submit(...args: unknown[]) {
        calls.submit.push(args);
        return taskId("task-1");
      },
      async cancel() {
        return true;
      },
      async schedule(...args: unknown[]) {
        calls.schedule.push(args);
        attempt += 1;
        if (attempt === 1) {
          throw preCommitRejection("schedule() does not support delayMs");
        }
        return scheduleId("schedule-2");
      },
      async unschedule() {
        return true;
      },
      async pause() {
        return true;
      },
      async resume() {
        return true;
      },
      async query() {
        return [];
      },
      async stats() {
        return {
          pending: 0,
          running: 0,
          completed: 0,
          failed: 0,
          deadLettered: 0,
          activeSchedules: 0,
          pausedSchedules: 0,
        };
      },
      async history() {
        return [];
      },
    };
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler: validatingScheduler,
      notify: async () => ({ delivered: true }),
      executionLog: log,
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
      triggerEmittedAt: 1,
      steps: [
        {
          kind: "create_schedule",
          expression: "0 9 * * *",
          agentId: agentId("agent-1"),
          mode: "spawn",
          input: { kind: "text", text: "daily" },
        },
      ],
      estimatedCost: 1,
      requiresApproval: false,
    };

    const first = await executor.execute(trigger(), plan);
    expect(first.status).toBe("failed");
    // Pre-commit rejection released the claim — store is empty.
    expect(store.size).toBe(0);

    // Ordinary retry succeeds; no operator intervention required.
    const second = await executor.execute(trigger(), plan);
    expect(second.status).toBe("executed");
    expect(calls.schedule).toHaveLength(2);
  });

  test("ambiguous schedule() throw exposes idempotencyKey on the first failure", async () => {
    const { calls } = schedulerStub();
    const { log } = inMemoryExecutionLog();
    const failingScheduler: SchedulerComponent = {
      async submit(...args: unknown[]) {
        calls.submit.push(args);
        return taskId("task-1");
      },
      async cancel() {
        return true;
      },
      async schedule(...args: unknown[]) {
        calls.schedule.push(args);
        throw new Error("ambiguous");
      },
      async unschedule() {
        return true;
      },
      async pause() {
        return true;
      },
      async resume() {
        return true;
      },
      async query() {
        return [];
      },
      async stats() {
        return {
          pending: 0,
          running: 0,
          completed: 0,
          failed: 0,
          deadLettered: 0,
          activeSchedules: 0,
          pausedSchedules: 0,
        };
      },
      async history() {
        return [];
      },
    };
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler: failingScheduler,
      notify: async () => ({ delivered: true }),
      executionLog: log,
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
      triggerEmittedAt: 1,
      steps: [
        {
          kind: "create_schedule",
          expression: "0 9 * * *",
          agentId: agentId("agent-1"),
          mode: "spawn",
          input: { kind: "text", text: "daily" },
        },
      ],
      estimatedCost: 1,
      requiresApproval: false,
    };

    const result = await executor.execute(trigger(), plan);
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({
      code: "STEP_FAILED",
      stepKind: "create_schedule",
      idempotencyKey: expect.stringMatching(/^cmp-[0-9a-f]{32}$/),
    });
  });

  test("release() failure during pre-commit rejection returns structured failure", async () => {
    const { calls } = schedulerStub();
    // Log whose release() always rejects — simulates a degraded backend.
    const log = {
      claim: (_key: string) => ({ kind: "claimed" }) as const,
      record: (_key: string, _output: unknown) => {},
      release: (_key: string) => {
        throw new Error("log backend unavailable");
      },
    };
    const flakyScheduler: SchedulerComponent = {
      async submit(...args: unknown[]) {
        calls.submit.push(args);
        return taskId("task-1");
      },
      async cancel() {
        return true;
      },
      async schedule() {
        throw preCommitRejection("invalid expression");
      },
      async unschedule() {
        return true;
      },
      async pause() {
        return true;
      },
      async resume() {
        return true;
      },
      async query() {
        return [];
      },
      async stats() {
        return {
          pending: 0,
          running: 0,
          completed: 0,
          failed: 0,
          deadLettered: 0,
          activeSchedules: 0,
          pausedSchedules: 0,
        };
      },
      async history() {
        return [];
      },
    };
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler: flakyScheduler,
      notify: async () => ({ delivered: true }),
      executionLog: log,
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
      triggerEmittedAt: 1,
      steps: [
        {
          kind: "create_schedule",
          expression: "0 9 * * *",
          agentId: agentId("agent-1"),
          mode: "spawn",
          input: { kind: "text", text: "daily" },
        },
      ],
      estimatedCost: 1,
      requiresApproval: false,
    };

    // execute() must NOT throw — it must return a structured result.
    const result = await executor.execute(trigger(), plan);
    expect(result.status).toBe("failed");
    expect(result.error?.message).toContain("invalid expression");
    expect(result.error?.message).toContain("release() also failed");
    expect(result.error).toMatchObject({
      idempotencyKey: expect.stringMatching(/^cmp-[0-9a-f]{32}$/),
    });
  });

  test("operator can recover a stuck-pending entry by calling record() after external confirmation", async () => {
    const { scheduler, calls } = schedulerStub();
    const { log, store } = inMemoryExecutionLog();
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async () => ({ delivered: true }),
      executionLog: log,
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
      triggerEmittedAt: 1,
      steps: [
        {
          kind: "create_schedule",
          expression: "0 9 * * *",
          agentId: agentId("agent-1"),
          mode: "spawn",
          input: { kind: "text", text: "daily" },
        },
      ],
      estimatedCost: 1,
      requiresApproval: false,
    };

    await executor.execute(trigger(), plan);
    const [key] = Array.from(store.keys());
    // Simulate a transient record() outage that left the entry pending
    // even though the scheduler had committed.
    store.set(key!, { kind: "pending" });

    // Operator confirms externally that the schedule exists and finalizes.
    log.record(key!, scheduleId("schedule-recovered"));

    // Subsequent retries now short-circuit with the recovered output —
    // no second schedule() call.
    const recovered = await executor.execute(trigger(), plan);
    expect(recovered.status).toBe("executed");
    expect(recovered.stepResults[0]?.output).toBe(scheduleId("schedule-recovered"));
    expect(calls.schedule).toHaveLength(1);
  });

  test("rejects plan whose triggerEmittedAt does not match the trigger emission", async () => {
    const { scheduler, calls } = schedulerStub();
    const { log } = inMemoryExecutionLog();
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async () => ({ delivered: true }),
      executionLog: log,
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
      triggerEmittedAt: 99, // Stale: actual trigger is emittedAt=1.
      steps: [
        {
          kind: "submit_task",
          agentId: agentId("agent-1"),
          mode: "dispatch",
          input: { kind: "text", text: "stale" },
        },
      ],
      estimatedCost: 1,
      requiresApproval: false,
    };

    const result = await executor.execute(trigger(), plan);

    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({
      code: "INVALID_PLAN",
    });
    expect(result.error?.message).toContain("triggerEmittedAt");
    expect(calls.submit).toHaveLength(0);
  });

  test("two submit_task steps differing only in ignored idempotencyKey hash to the same key", async () => {
    const { scheduler: schedulerA, calls: callsA } = schedulerStub();
    const { scheduler: schedulerB, calls: callsB } = schedulerStub();
    const executorA = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler: schedulerA,
      notify: async () => ({ delivered: true }),
      executionLog: inMemoryExecutionLog().log,
    });
    const executorB = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler: schedulerB,
      notify: async () => ({ delivered: true }),
      executionLog: inMemoryExecutionLog().log,
    });
    const baseStep = {
      kind: "submit_task",
      agentId: agentId("agent-1"),
      mode: "dispatch",
      input: { kind: "text", text: "x" },
    } as const;
    const planA: CompositionPlan = {
      triggerId: "trigger-1",
      triggerEmittedAt: 1,
      steps: [{ ...baseStep, taskOptions: { idempotencyKey: "alpha" } }],
      estimatedCost: 1,
      requiresApproval: false,
    };
    const planB: CompositionPlan = {
      ...planA,
      steps: [{ ...baseStep, taskOptions: { idempotencyKey: "beta" } }],
    };

    await executorA.execute(trigger(), planA);
    await executorB.execute(trigger(), planB);

    const k0 = (callsA.submit[0] as readonly unknown[])[2] as { idempotencyKey: string };
    const k1 = (callsB.submit[0] as readonly unknown[])[2] as { idempotencyKey: string };
    expect(k0.idempotencyKey).toBe(k1.idempotencyKey);
  });

  test("submit_task ignores planner-supplied taskOptions.idempotencyKey", async () => {
    const { scheduler, calls } = schedulerStub();
    const { log } = inMemoryExecutionLog();
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async () => ({ delivered: true }),
      executionLog: log,
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
      triggerEmittedAt: 1,
      steps: [
        {
          kind: "submit_task",
          agentId: agentId("agent-1"),
          mode: "dispatch",
          input: { kind: "text", text: "x" },
          taskOptions: { idempotencyKey: "planner-collision-key", priority: 3 },
        },
      ],
      estimatedCost: 1,
      requiresApproval: false,
    };

    await executor.execute(trigger(), plan);

    const opts = (calls.submit[0] as readonly unknown[])[2] as Record<string, unknown>;
    expect(opts.idempotencyKey).not.toBe("planner-collision-key");
    expect(opts.idempotencyKey).toMatch(/^cmp-[0-9a-f]{32}$/);
    // Other options pass through unchanged.
    expect(opts.priority).toBe(3);
  });

  test("identical steps in one plan each fire (occurrence index disambiguates)", async () => {
    const { scheduler, calls } = schedulerStub();
    const notifications: unknown[] = [];
    const { log } = inMemoryExecutionLog();
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async (notification) => {
        notifications.push(notification);
        return { delivered: true };
      },
      executionLog: log,
    });
    const dupNotify = {
      kind: "notify_user" as const,
      channel: "inbox",
      message: "ping",
      priority: "normal" as const,
    };
    const dupSubmit = {
      kind: "submit_task" as const,
      agentId: agentId("agent-1"),
      mode: "dispatch" as const,
      input: { kind: "text" as const, text: "follow up" },
    };
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
      triggerEmittedAt: 1,
      steps: [dupSubmit, dupSubmit, dupNotify, dupNotify],
      estimatedCost: 1,
      requiresApproval: false,
    };

    const result = await executor.execute(trigger(), plan);

    expect(result.status).toBe("executed");
    expect(result.executedCount).toBe(4);
    // Each duplicate step fires; submit() and notify() each receive 2 calls
    // with distinct idempotency keys (occurrence index varies).
    expect(calls.submit).toHaveLength(2);
    expect(notifications).toHaveLength(2);
    const submitKeys = (calls.submit as readonly (readonly unknown[])[]).map(
      (call) => (call[2] as Record<string, unknown>).idempotencyKey,
    );
    expect(submitKeys[0]).not.toBe(submitKeys[1]);
    const notifyKeys = (notifications as readonly Record<string, unknown>[]).map(
      (n) => n.idempotencyKey,
    );
    expect(notifyKeys[0]).not.toBe(notifyKeys[1]);
  });

  test("notify_user keys are scoped per agent on a shared executionLog", async () => {
    const { scheduler } = schedulerStub();
    const { log } = inMemoryExecutionLog();
    const notifsA: unknown[] = [];
    const notifsB: unknown[] = [];
    const executorA = createCompositionExecutor({
      agentId: agentId("agent-A"),
      scheduler,
      notify: async (n) => {
        notifsA.push(n);
        return { delivered: true };
      },
      executionLog: log,
    });
    const executorB = createCompositionExecutor({
      agentId: agentId("agent-B"),
      scheduler,
      notify: async (n) => {
        notifsB.push(n);
        return { delivered: true };
      },
      executionLog: log,
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
      triggerEmittedAt: 1,
      steps: [{ kind: "notify_user", channel: "inbox", message: "hi", priority: "normal" }],
      estimatedCost: 1,
      requiresApproval: false,
    };

    const resA = await executorA.execute(trigger(), plan);
    const resB = await executorB.execute(trigger(), plan);

    // Each agent must deliver its own notification — the shared log must
    // not collapse cross-agent dispatches into one.
    expect(resA.status).toBe("executed");
    expect(resB.status).toBe("executed");
    expect(notifsA).toHaveLength(1);
    expect(notifsB).toHaveLength(1);
  });

  // Note: a plan without triggerEmittedAt is now a TypeScript-level error
  // — the L0 CompositionPlan contract requires it. No runtime test needed.

  test("empty plan with requiresApproval=false fails as INVALID_PLAN", async () => {
    const { scheduler } = schedulerStub();
    const { log, store } = inMemoryExecutionLog();
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async () => ({ delivered: true }),
      executionLog: log,
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
      triggerEmittedAt: 1,
      steps: [],
      estimatedCost: 0,
      requiresApproval: false,
    };

    const result = await executor.execute(trigger(), plan);

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("INVALID_PLAN");
    expect(store.size).toBe(0);
  });

  test("create_schedule with malformed cron rejects as INVALID_PLAN before claim", async () => {
    const { scheduler, calls } = schedulerStub();
    const { log, store } = inMemoryExecutionLog();
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async () => ({ delivered: true }),
      executionLog: log,
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
      triggerEmittedAt: 1,
      steps: [
        {
          kind: "create_schedule",
          expression: "0 9 * *",
          agentId: agentId("agent-1"),
          mode: "spawn",
          input: { kind: "text", text: "x" },
        },
      ],
      estimatedCost: 1,
      requiresApproval: false,
    };

    const result = await executor.execute(trigger(), plan);

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("INVALID_PLAN");
    expect(calls.schedule).toHaveLength(0);
    // Pre-commit rejection must NOT poison the execution log.
    expect(store.size).toBe(0);
  });

  test("circular step payload returns INVALID_PLAN instead of crashing execute()", async () => {
    const { scheduler, calls } = schedulerStub();
    const { log, store } = inMemoryExecutionLog();
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async () => ({ delivered: true }),
      executionLog: log,
    });
    // Build a step whose canonicalization will throw (circular reference).
    const cyclicMetadata: Record<string, unknown> = {};
    cyclicMetadata.self = cyclicMetadata;
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
      triggerEmittedAt: 1,
      steps: [
        {
          kind: "submit_task",
          agentId: agentId("agent-1"),
          mode: "dispatch",
          input: { kind: "text", text: "x" },
          taskOptions: { metadata: cyclicMetadata },
        },
      ],
      estimatedCost: 1,
      requiresApproval: false,
    };

    const result = await executor.execute(trigger(), plan);

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("INVALID_PLAN");
    expect(calls.submit).toHaveLength(0);
    // No execution-log entries created for a pre-claim crash.
    expect(store.size).toBe(0);
  });

  test("isPreCommitRejection() recognizes only the exported helper-built rejection", async () => {
    const built = preCommitRejection("nope");
    expect(isPreCommitRejection(built)).toBe(true);

    // Forged plain-property errors are NOT recognized — the brand is
    // unforgeable so a misclassified or adversarial adapter cannot trick
    // the executor into releasing a claimed key.
    const forged = Object.assign(new Error("forged"), { preCommitRejection: true });
    expect(isPreCommitRejection(forged)).toBe(false);

    expect(isPreCommitRejection(new Error("boom"))).toBe(false);
    expect(isPreCommitRejection({})).toBe(false);
  });

  test("isPreCommitRejection() recognizes the brand on non-Error objects (cross-realm)", async () => {
    // Simulates an Error from another realm/bundle that fails same-realm
    // `instanceof Error` but still carries the shared Symbol.for() brand.
    const brand = Symbol.for("@koi/proactive/preCommitRejection");
    const crossRealm: Record<string | symbol, unknown> = { message: "x", [brand]: true };
    expect(isPreCommitRejection(crossRealm)).toBe(true);

    // null/undefined/primitives still rejected.
    expect(isPreCommitRejection(null)).toBe(false);
    expect(isPreCommitRejection(undefined)).toBe(false);
    expect(isPreCommitRejection("brand")).toBe(false);
    expect(isPreCommitRejection(42)).toBe(false);
  });
});

describe("createCompositionExecutor — checkpoint store wiring", () => {
  function twoStepPlan(): CompositionPlan {
    return {
      triggerId: "trigger-1",
      triggerEmittedAt: 1,
      steps: [
        { kind: "notify_user", channel: "inbox", message: "first", priority: "normal" },
        { kind: "notify_user", channel: "inbox", message: "second", priority: "normal" },
      ],
      estimatedCost: 1,
      requiresApproval: false,
    };
  }

  test("saves a snapshot after each successful step and deletes on terminal success", async () => {
    const { scheduler } = schedulerStub();
    const { store, saves, deletes } = recordingCheckpointStore();
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async () => ({ delivered: true }),
      executionLog: inMemoryExecutionLog().log,
      checkpointStore: store,
      executionId: "exec-1",
    });

    const result = await executor.execute(trigger(), twoStepPlan());

    expect(result.status).toBe("executed");
    expect(saves).toHaveLength(2);
    expect(saves[0]).toMatchObject({
      executionId: "exec-1",
      nextStepIndex: 1,
      phase: "in_progress",
    });
    expect(saves[0]?.stepResults).toEqual([{ delivered: true }]);
    expect(saves[1]).toMatchObject({
      executionId: "exec-1",
      nextStepIndex: 2,
      phase: "in_progress",
    });
    expect(saves[1]?.stepResults).toEqual([{ delivered: true }, { delivered: true }]);
    // Same planHash across both snapshots.
    expect(saves[0]?.planHash).toBe(saves[1]?.planHash ?? "");
    expect(deletes).toEqual(["exec-1"]);
  });

  test("saves phase=failed snapshot on terminal failure (mid-plan throw)", async () => {
    const { scheduler } = schedulerStub();
    const { store, saves, deletes } = recordingCheckpointStore();
    let count = 0;
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async () => {
        count += 1;
        if (count === 2) throw new Error("transient");
        return { delivered: true };
      },
      executionLog: inMemoryExecutionLog().log,
      checkpointStore: store,
      executionId: "exec-2",
    });

    const result = await executor.execute(trigger(), twoStepPlan());

    expect(result.status).toBe("failed");
    // One in_progress (step 1) + one failed (terminal).
    expect(saves).toHaveLength(2);
    expect(saves[0]).toMatchObject({ nextStepIndex: 1, phase: "in_progress" });
    expect(saves[1]).toMatchObject({ nextStepIndex: 1, phase: "failed" });
    expect(deletes).toHaveLength(0);
  });

  test("saves phase=failed snapshot on unsupported terminal", async () => {
    const { scheduler } = schedulerStub();
    const { store, saves, deletes } = recordingCheckpointStore();
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async () => ({ delivered: true }),
      executionLog: inMemoryExecutionLog().log,
      checkpointStore: store,
      executionId: "exec-3",
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
      triggerEmittedAt: 1,
      steps: [
        { kind: "notify_user", channel: "inbox", message: "first", priority: "normal" },
        { kind: "tool_call", toolName: "missing", input: {} },
      ],
      estimatedCost: 1,
      requiresApproval: false,
    };

    const result = await executor.execute(trigger(), plan);

    expect(result.status).toBe("unsupported");
    expect(saves).toHaveLength(2);
    expect(saves[0]).toMatchObject({ nextStepIndex: 1, phase: "in_progress" });
    expect(saves[1]).toMatchObject({ nextStepIndex: 1, phase: "failed" });
    expect(deletes).toHaveLength(0);
  });

  test("returns INVALID_PLAN when checkpointStore is wired without executionId", async () => {
    const { scheduler } = schedulerStub();
    const { store, saves, deletes } = recordingCheckpointStore();
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async () => ({ delivered: true }),
      executionLog: inMemoryExecutionLog().log,
      checkpointStore: store,
    });

    const result = await executor.execute(trigger(), twoStepPlan());

    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ code: "INVALID_PLAN" });
    expect(saves).toHaveLength(0);
    expect(deletes).toHaveLength(0);
  });

  test("returns INVALID_PLAN when executionId is the empty string", async () => {
    const { scheduler } = schedulerStub();
    const { store } = recordingCheckpointStore();
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async () => ({ delivered: true }),
      executionLog: inMemoryExecutionLog().log,
      checkpointStore: store,
      executionId: "",
    });

    const result = await executor.execute(trigger(), twoStepPlan());

    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ code: "INVALID_PLAN" });
  });

  test("save failures are swallowed; executor still returns structured success", async () => {
    const { scheduler } = schedulerStub();
    const throwingStore: CompositionCheckpointStore = {
      save: () => {
        throw new Error("backend down");
      },
      load: () => undefined,
      delete: () => {
        throw new Error("backend down");
      },
      list: () => {
        throw new Error("backend down");
      },
    };
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async () => ({ delivered: true }),
      executionLog: inMemoryExecutionLog().log,
      checkpointStore: throwingStore,
      executionId: "exec-throw",
    });

    const result = await executor.execute(trigger(), twoStepPlan());

    expect(result.status).toBe("executed");
    expect(result.executedCount).toBe(2);
  });

  test("default planHash is stable across logically equivalent plans", async () => {
    const { scheduler } = schedulerStub();
    const { store: storeA, saves: savesA } = recordingCheckpointStore();
    const { store: storeB, saves: savesB } = recordingCheckpointStore();

    const planA: CompositionPlan = {
      triggerId: "trigger-1",
      triggerEmittedAt: 1,
      steps: [{ kind: "notify_user", channel: "inbox", message: "x", priority: "normal" }],
      estimatedCost: 1,
      requiresApproval: false,
    };
    // Same logical plan; the canonicalizer should produce identical JSON.
    const planB: CompositionPlan = {
      requiresApproval: false,
      estimatedCost: 1,
      triggerEmittedAt: 1,
      steps: [{ priority: "normal", message: "x", channel: "inbox", kind: "notify_user" }],
      triggerId: "trigger-1",
    };

    const execA = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async () => ({ delivered: true }),
      executionLog: inMemoryExecutionLog().log,
      checkpointStore: storeA,
      executionId: "a",
    });
    const execB = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async () => ({ delivered: true }),
      executionLog: inMemoryExecutionLog().log,
      checkpointStore: storeB,
      executionId: "b",
    });

    await execA.execute(trigger(), planA);
    await execB.execute(trigger(), planB);

    expect(savesA[0]?.planHash).toBe(savesB[0]?.planHash ?? "");
  });

  test("custom hashPlan override is respected", async () => {
    const { scheduler } = schedulerStub();
    const { store, saves } = recordingCheckpointStore();
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async () => ({ delivered: true }),
      executionLog: inMemoryExecutionLog().log,
      checkpointStore: store,
      executionId: "exec-custom",
      hashPlan: () => "fixed-hash",
    });

    await executor.execute(trigger(), twoStepPlan());

    expect(saves[0]?.planHash).toBe("fixed-hash");
    expect(saves[1]?.planHash).toBe("fixed-hash");
  });

  test("requires_approval does NOT persist a failed snapshot", async () => {
    const { scheduler } = schedulerStub();
    const { store, saves, deletes } = recordingCheckpointStore();
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async () => ({ delivered: true }),
      executionLog: inMemoryExecutionLog().log,
      checkpointStore: store,
      executionId: "exec-approval",
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
      triggerEmittedAt: 1,
      steps: [{ kind: "notify_user", channel: "inbox", message: "hi", priority: "normal" }],
      estimatedCost: 1,
      // plan-level approval gate — runs zero steps and returns requires_approval.
      requiresApproval: true,
    };

    const result = await executor.execute(trigger(), plan);

    expect(result.status).toBe("requires_approval");
    // No snapshot writes: approval-pending is tracked through the approval
    // signal contract, not the checkpoint store. Persisting "failed" here
    // would cause restart watchdogs to confuse pending-approval with true
    // failure and trigger the wrong remediation.
    expect(saves).toHaveLength(0);
    expect(deletes).toHaveLength(0);
  });

  test("without checkpointStore, no snapshot calls occur (behavior unchanged)", async () => {
    const { scheduler } = schedulerStub();
    // No store wired — but recording one to prove it stays untouched.
    const { store, saves, deletes } = recordingCheckpointStore();
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async () => ({ delivered: true }),
      executionLog: inMemoryExecutionLog().log,
      // intentionally NOT wiring checkpointStore
    });

    const result = await executor.execute(trigger(), twoStepPlan());

    expect(result.status).toBe("executed");
    // Sanity: the unused store recorded nothing.
    expect(saves).toHaveLength(0);
    expect(deletes).toHaveLength(0);
    void store;
  });
});
