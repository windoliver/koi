import { describe, expect, test } from "bun:test";
import {
  agentId,
  type CompositionPlan,
  type CompositionTrigger,
  type SchedulerComponent,
  scheduleId,
  taskId,
} from "../../../kernel/core/src/index.js";
import {
  createCompositionExecutor,
  isPreCommitRejection,
  preCommitRejection,
} from "./composition-executor.js";

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
    async submit(...args) {
      calls.submit.push(args);
      return taskId("task-1");
    },
    async cancel() {
      return true;
    },
    async schedule(...args) {
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
    async submit(...args) {
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
    async schedule(...args) {
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

    // Identical replays produce identical keys → downstream dedupe collapses.
    const submitKey0 = (calls.submit[0] as readonly unknown[])[2] as { idempotencyKey: string };
    const submitKey1 = (calls.submit[1] as readonly unknown[])[2] as { idempotencyKey: string };
    expect(submitKey0.idempotencyKey).toBe(submitKey1.idempotencyKey);
    expect(submitKey0.idempotencyKey).not.toContain(":"); // Temporal-safe.

    // schedule() must NOT carry idempotencyKey — backend rejects it.
    const scheduleOpts0 = (calls.schedule[0] as readonly unknown[])[3] as Record<string, unknown>;
    expect(scheduleOpts0).not.toHaveProperty("idempotencyKey");

    // create_schedule and notify_user MUST short-circuit on replay via the
    // executionLog — exactly one underlying side-effect call across both
    // executions, even though both runs report the steps as executed.
    expect(calls.schedule).toHaveLength(1);
    expect(notifications).toHaveLength(1);
  });

  test("create_schedule rejects unsupported taskOptions as INVALID_PLAN before claiming", async () => {
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
          taskOptions: { idempotencyKey: "planner-supplied", maxRetries: 2 },
        },
      ],
      estimatedCost: 1,
      requiresApproval: false,
    };

    const result = await executor.execute(trigger(), plan);

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("INVALID_PLAN");
    expect(calls.schedule).toHaveLength(0);
    // Pre-commit validation must NOT poison the execution log with a
    // pending claim — deterministic failures stay re-plannable.
    expect(store.size).toBe(0);
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
      async submit(...args) {
        calls.submit.push(args);
        return taskId("task-1");
      },
      async cancel() {
        return true;
      },
      async schedule(...args) {
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
      async submit(...args) {
        calls.submit.push(args);
        return taskId("task-1");
      },
      async cancel() {
        return true;
      },
      async schedule(...args) {
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
      async submit(...args) {
        calls.submit.push(args);
        return taskId("task-1");
      },
      async cancel() {
        return true;
      },
      async schedule(...args) {
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
      async submit(...args) {
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
    const { scheduler, calls } = schedulerStub();
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
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

    await executor.execute(trigger(), planA);
    await executor.execute(trigger(), planB);

    const k0 = (calls.submit[0] as readonly unknown[])[2] as { idempotencyKey: string };
    const k1 = (calls.submit[1] as readonly unknown[])[2] as { idempotencyKey: string };
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
          expression: "not a real cron expression",
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
});
