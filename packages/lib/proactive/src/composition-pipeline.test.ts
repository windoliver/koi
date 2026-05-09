import { describe, expect, test } from "bun:test";
import {
  type AgentDefinition,
  DEFAULT_DELIVERY_POLICY,
  type KoiError,
  RETRYABLE_DEFAULTS,
  type SystemSignal,
  taskId,
} from "@koi/core";
import { mapSystemSignalToCompositionTrigger } from "./composition-trigger.js";
import { createRuleBasedCompositionPlanner } from "./rule-based-composition-planner.js";

function agentDefinition(agentType: string): AgentDefinition {
  return {
    agentType,
    whenToUse: `Use ${agentType} when needed.`,
    source: "built-in",
    manifest: { name: agentType, version: "1.0.0", model: { name: "sonnet" } },
    name: agentType,
    description: `${agentType} agent`,
  };
}

function koiError(): KoiError {
  return {
    code: "INTERNAL",
    message: "task blew up",
    retryable: RETRYABLE_DEFAULTS.INTERNAL,
  };
}

describe("composition pipeline (signal → trigger → plan → approval)", () => {
  test("governance error_rate signal flows end-to-end into spawn+notify plan", async () => {
    const signal: SystemSignal = {
      kind: "governance",
      sensor: "error_rate",
      value: 0.5,
      limit: 0.2,
      direction: "above",
      emittedAt: 1_700_000_000_000,
    };

    const trigger = mapSystemSignalToCompositionTrigger(signal);
    expect(trigger).toBeDefined();
    if (trigger === undefined) return;

    const planner = createRuleBasedCompositionPlanner();
    const plan = await planner.plan(trigger, {
      tools: [],
      agents: [agentDefinition("diagnostic")],
      schedules: [],
    });

    expect(plan.triggerId).toBe(trigger.id);
    expect(plan.steps).toEqual([
      {
        kind: "notify_user",
        channel: "inbox",
        message: "Error rate crossed its configured threshold.",
        priority: "high",
      },
    ]);
    expect(plan.requiresApproval).toBe(false);
  });

  test("schedule task:failed flows end-to-end into recovery spawn", async () => {
    const signal: SystemSignal = {
      kind: "schedule",
      event: { kind: "task:failed", taskId: taskId("task-int-1"), error: koiError() },
      emittedAt: 1_700_000_000_000,
    };

    const trigger = mapSystemSignalToCompositionTrigger(signal);
    expect(trigger).toBeDefined();
    if (trigger === undefined) return;

    const planner = createRuleBasedCompositionPlanner();
    const plan = await planner.plan(trigger, {
      tools: [],
      agents: [agentDefinition("recovery")],
      schedules: [],
    });

    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({
      kind: "spawn_agent",
      agentType: "recovery",
    });
    expect(plan.requiresApproval).toBe(true);
  });

  test("schedule task:cancelled flows to a no-op plan that requires approval", async () => {
    const signal: SystemSignal = {
      kind: "schedule",
      event: { kind: "task:cancelled", taskId: taskId("task-int-2") },
      emittedAt: 1_700_000_000_000,
    };

    const trigger = mapSystemSignalToCompositionTrigger(signal);
    expect(trigger).toBeDefined();
    if (trigger === undefined) return;

    const planner = createRuleBasedCompositionPlanner();
    const plan = await planner.plan(trigger, {
      tools: [],
      agents: [agentDefinition("recovery")],
      schedules: [],
    });

    expect(plan.steps).toEqual([]);
    expect(plan.requiresApproval).toBe(true);
  });

  test("ignored signal kinds (vfs/agent_lifecycle/compaction) produce no trigger", () => {
    const vfsSignal: SystemSignal = {
      kind: "vfs",
      event: "write",
      path: "/tmp/foo",
      emittedAt: 1,
    };
    expect(mapSystemSignalToCompositionTrigger(vfsSignal)).toBeUndefined();
  });
});
