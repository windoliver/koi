import { describe, expect, test } from "bun:test";
import {
  type AgentDefinition,
  type CompositionTrigger,
  DEFAULT_DELIVERY_POLICY,
  type SystemSignal,
  taskId,
} from "@koi/core";
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

describe("createRuleBasedCompositionPlanner", () => {
  test("plans forge work for capability gap triggers carrying forge demand context", async () => {
    const planner = createRuleBasedCompositionPlanner();
    const forgeDemand = {
      id: "fd-1",
      kind: "forge_demand",
      confidence: 0.9,
      suggestedBrickKind: "skill",
      trigger: { kind: "capability_gap", requiredCapability: "diagnostics" },
      context: { failureCount: 1, failedToolCalls: [] },
      emittedAt: 1,
    } as const satisfies SystemSignal;

    const trigger: CompositionTrigger = {
      id: "gap-1",
      source: "forge_demand",
      confidence: 0.9,
      moment: { kind: "capability_gap", missing: "diagnostics" },
      suggestedCapabilities: ["forge_skill"],
      context: { forgeDemand },
      emittedAt: 1,
    };

    const plan = await planner.plan(trigger, {
      tools: [],
      agents: [],
      schedules: [],
    });

    expect(plan.steps).toEqual([{ kind: "forge_skill", demand: forgeDemand }]);
    expect(plan.estimatedCost).toBe(4);
    expect(plan.requiresApproval).toBe(true);
  });

  test("plans diagnostic spawn for error_rate thresholds", async () => {
    const planner = createRuleBasedCompositionPlanner();
    const trigger: CompositionTrigger = {
      id: "gov-1",
      source: "governance",
      confidence: 1,
      moment: {
        kind: "threshold_crossed",
        sensor: "error_rate",
        value: 0.6,
        limit: 0.2,
        direction: "above",
      },
      suggestedCapabilities: ["spawn_agent", "notify_user"],
      context: {},
      emittedAt: 1,
    };

    const plan = await planner.plan(trigger, {
      tools: [],
      agents: [agentDefinition("diagnostic")],
      schedules: [],
    });

    expect(plan.steps).toContainEqual({
      kind: "spawn_agent",
      agentType: "diagnostic",
      input: { kind: "text", text: "Investigate elevated error_rate and summarize root causes." },
      delivery: DEFAULT_DELIVERY_POLICY,
    });
  });

  test("plans recovery spawn for failed task terminals", async () => {
    const planner = createRuleBasedCompositionPlanner();
    const trigger: CompositionTrigger = {
      id: "task-1",
      source: "schedule",
      confidence: 1,
      moment: {
        kind: "task_terminal",
        taskId: taskId("task-1"),
        outcome: "failed",
      },
      suggestedCapabilities: ["spawn_agent"],
      context: {},
      emittedAt: 1,
    };

    const plan = await planner.plan(trigger, {
      tools: [],
      agents: [agentDefinition("recovery")],
      schedules: [],
    });

    expect(plan.steps).toEqual([
      {
        kind: "spawn_agent",
        agentType: "recovery",
        input: {
          kind: "text",
          text: "Analyze failed scheduled task task-1 and propose recovery.",
        },
        delivery: DEFAULT_DELIVERY_POLICY,
      },
    ]);
    expect(plan.requiresApproval).toBe(true);
  });

  test("plans deferred frontier research for frontier changes", async () => {
    const planner = createRuleBasedCompositionPlanner();
    const trigger: CompositionTrigger = {
      id: "frontier-1",
      source: "anomaly",
      confidence: 1,
      moment: {
        kind: "frontier_changed",
        metric: "retrieval_quality",
        improvement: 0.2,
      },
      suggestedCapabilities: ["spawn_agent"],
      context: {},
      emittedAt: 1,
    };

    const plan = await planner.plan(trigger, {
      tools: [],
      agents: [agentDefinition("researcher")],
      schedules: [],
    });

    expect(plan.steps).toEqual([
      {
        kind: "spawn_agent",
        agentType: "researcher",
        input: {
          kind: "text",
          text: "Investigate frontier change in retrieval_quality.",
        },
        delivery: { kind: "deferred" },
      },
    ]);
  });

  test("requires approval for recognized triggers that yield no deterministic steps", async () => {
    const planner = createRuleBasedCompositionPlanner();
    const trigger: CompositionTrigger = {
      id: "event-1",
      source: "external",
      confidence: 1,
      moment: {
        kind: "external_event",
        source: "slack",
        eventType: "mention",
      },
      suggestedCapabilities: [],
      context: {},
      emittedAt: 1,
    };

    const plan = await planner.plan(trigger, {
      tools: [],
      agents: [],
      schedules: [],
    });

    expect(plan.steps).toEqual([]);
    expect(plan.estimatedCost).toBe(0);
    expect(plan.requiresApproval).toBe(true);
  });

  test("cancelled terminal outcome stays quiet", async () => {
    const planner = createRuleBasedCompositionPlanner();
    const trigger: CompositionTrigger = {
      id: "task-cancelled",
      source: "schedule",
      confidence: 1,
      moment: {
        kind: "task_terminal",
        taskId: taskId("task-cancelled"),
        outcome: "cancelled",
      },
      suggestedCapabilities: ["spawn_agent"],
      context: {},
      emittedAt: 1,
    };

    const plan = await planner.plan(trigger, {
      tools: [],
      agents: [agentDefinition("recovery")],
      schedules: [],
    });

    expect(plan.steps).toEqual([]);
    expect(plan.requiresApproval).toBe(true);
  });

  test("non-skill forge demand does not auto-plan a misleading forge step", async () => {
    const planner = createRuleBasedCompositionPlanner();
    const forgeDemand = {
      id: "fd-agent-1",
      kind: "forge_demand",
      confidence: 0.9,
      suggestedBrickKind: "agent",
      trigger: { kind: "agent_capability_gap", agentType: "researcher" },
      context: { failureCount: 1, failedToolCalls: [] },
      emittedAt: 1,
    } as const satisfies SystemSignal;

    const trigger: CompositionTrigger = {
      id: "gap-agent-1",
      source: "forge_demand",
      confidence: 0.9,
      moment: { kind: "capability_gap", missing: "researcher" },
      suggestedCapabilities: ["forge_agent"],
      context: { forgeDemand },
      emittedAt: 1,
    };

    const plan = await planner.plan(trigger, {
      tools: [],
      agents: [],
      schedules: [],
    });

    expect(plan.steps).toEqual([]);
    expect(plan.requiresApproval).toBe(true);
  });

  test("malformed forge demand context does not emit forge work", async () => {
    const planner = createRuleBasedCompositionPlanner();
    const trigger: CompositionTrigger = {
      id: "gap-malformed-1",
      source: "forge_demand",
      confidence: 0.9,
      moment: { kind: "capability_gap", missing: "diagnostics" },
      suggestedCapabilities: ["forge_skill"],
      context: {
        forgeDemand: {
          suggestedBrickKind: "skill",
        },
      },
      emittedAt: 1,
    };

    const plan = await planner.plan(trigger, {
      tools: [],
      agents: [],
      schedules: [],
    });

    expect(plan.steps).toEqual([]);
    expect(plan.estimatedCost).toBe(0);
    expect(plan.requiresApproval).toBe(true);
  });

  test("error-rate alerts still notify when diagnostic agents are unavailable", async () => {
    const planner = createRuleBasedCompositionPlanner();
    const trigger: CompositionTrigger = {
      id: "gov-missing-agent",
      source: "governance",
      confidence: 1,
      moment: {
        kind: "threshold_crossed",
        sensor: "error_rate",
        value: 0.6,
        limit: 0.2,
        direction: "above",
      },
      suggestedCapabilities: ["spawn_agent", "notify_user"],
      context: {},
      emittedAt: 1,
    };

    const plan = await planner.plan(trigger, {
      tools: [],
      agents: [],
      schedules: [],
    });

    expect(plan.steps).toEqual([
      {
        kind: "notify_user",
        channel: "inbox",
        message: "Error rate crossed its configured threshold.",
        priority: "high",
      },
    ]);
    expect(plan.estimatedCost).toBe(1);
    expect(plan.requiresApproval).toBe(false);
  });

  test("plans recovery spawn for dead_letter task terminals", async () => {
    const planner = createRuleBasedCompositionPlanner();
    const trigger: CompositionTrigger = {
      id: "task-dl-1",
      source: "schedule",
      confidence: 1,
      moment: {
        kind: "task_terminal",
        taskId: taskId("task-dl-1"),
        outcome: "dead_letter",
      },
      suggestedCapabilities: ["spawn_agent"],
      context: {},
      emittedAt: 1,
    };

    const plan = await planner.plan(trigger, {
      tools: [],
      agents: [agentDefinition("recovery")],
      schedules: [],
    });

    expect(plan.steps).toEqual([
      {
        kind: "spawn_agent",
        agentType: "recovery",
        input: {
          kind: "text",
          text: "Analyze failed scheduled task task-dl-1 and propose recovery.",
        },
        delivery: DEFAULT_DELIVERY_POLICY,
      },
    ]);
  });

  test("failed task without recovery agent emits no spawn (capability gating)", async () => {
    const planner = createRuleBasedCompositionPlanner();
    const trigger: CompositionTrigger = {
      id: "task-no-rec",
      source: "schedule",
      confidence: 1,
      moment: {
        kind: "task_terminal",
        taskId: taskId("task-no-rec"),
        outcome: "failed",
      },
      suggestedCapabilities: ["spawn_agent"],
      context: {},
      emittedAt: 1,
    };

    const plan = await planner.plan(trigger, {
      tools: [],
      agents: [],
      schedules: [],
    });

    expect(plan.steps).toEqual([]);
    expect(plan.requiresApproval).toBe(true);
  });

  test("frontier change without researcher agent emits no spawn (capability gating)", async () => {
    const planner = createRuleBasedCompositionPlanner();
    const trigger: CompositionTrigger = {
      id: "frontier-no-res",
      source: "anomaly",
      confidence: 1,
      moment: {
        kind: "frontier_changed",
        metric: "retrieval_quality",
        improvement: 0.3,
      },
      suggestedCapabilities: ["spawn_agent"],
      context: {},
      emittedAt: 1,
    };

    const plan = await planner.plan(trigger, {
      tools: [],
      agents: [],
      schedules: [],
    });

    expect(plan.steps).toEqual([]);
    expect(plan.requiresApproval).toBe(true);
  });
});
