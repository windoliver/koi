import { describe, expect, test } from "bun:test";
import {
  agentId,
  type CompositionPlan,
  type CompositionTrigger,
  type SchedulerComponent,
  scheduleId,
  taskId,
} from "../../../kernel/core/src/index.js";
import { createCompositionExecutor } from "./composition-executor.js";

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
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
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
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-other",
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
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
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
      { delayMs: 5 },
    ]);
  });

  test("executes create_schedule for the attached agent and records output", async () => {
    const { scheduler, calls } = schedulerStub();
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async () => ({ delivered: true }),
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
      steps: [
        {
          kind: "create_schedule",
          expression: "0 9 * * *",
          agentId: agentId("agent-1"),
          mode: "spawn",
          input: { kind: "text", text: "daily check-in" },
          timezone: "America/Los_Angeles",
          taskOptions: { maxRetries: 1 },
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
    expect(calls.schedule[0]).toEqual([
      "0 9 * * *",
      { kind: "text", text: "daily check-in" },
      "spawn",
      { maxRetries: 1, timezone: "America/Los_Angeles" },
    ]);
  });

  test("executes notify_user and records output", async () => {
    const { scheduler } = schedulerStub();
    const notifications: unknown[] = [];
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async (notification) => {
        notifications.push(notification);
        return { delivered: true };
      },
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
      steps: [{ kind: "notify_user", channel: "inbox", message: "hello", priority: "normal" }],
      estimatedCost: 1,
      requiresApproval: false,
    };

    const result = await executor.execute(trigger(), plan);

    expect(result.status).toBe("executed");
    expect(result.executedCount).toBe(1);
    expect(result.stepResults[0]?.status).toBe("executed");
    expect(result.stepResults[0]?.output).toEqual({ delivered: true });
    expect(notifications).toEqual([{ channel: "inbox", message: "hello", priority: "normal" }]);
  });

  test("fails when submit_task targets a different agentId than the attached scheduler", async () => {
    const { scheduler, calls } = schedulerStub();
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async () => ({ delivered: true }),
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
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
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
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
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
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
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async (notification) => {
        notifications.push(notification);
        return { delivered: true };
      },
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
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
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async (notification) => {
        notifications.push(notification);
        return { delivered: true };
      },
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
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
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
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
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async (notification) => {
        notifications.push(notification);
        return { delivered: true };
      },
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
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
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async () => {
        throw new Error("notify failed");
      },
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
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
    const executor = createCompositionExecutor({
      agentId: agentId("agent-1"),
      scheduler,
      notify: async () => {
        notifyCalls += 1;
        if (notifyCalls === 2) throw new Error("notify failed later");
        return { delivered: true };
      },
    });
    const plan: CompositionPlan = {
      triggerId: "trigger-1",
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
});
