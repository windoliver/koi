import { describe, expect, test } from "bun:test";
import { type AgentDefinition, type CompositionTrigger, DEFAULT_DELIVERY_POLICY } from "@koi/core";
import { createLlmCompositionPlanner } from "./llm-composition-planner.js";
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

describe("createLlmCompositionPlanner", () => {
  test("valid adapter JSON returns a parsed plan", async () => {
    const planner = createLlmCompositionPlanner({
      adapter: {
        async plan(): Promise<string> {
          return JSON.stringify({
            triggerId: "gov-1",
            steps: [
              {
                kind: "notify_user",
                channel: "inbox",
                message: "Threshold crossed",
                priority: "high",
              },
            ],
            estimatedCost: 2,
            requiresApproval: false,
          });
        },
      },
    });

    const trigger: CompositionTrigger = {
      id: "gov-1",
      source: "governance",
      confidence: 1,
      moment: {
        kind: "threshold_crossed",
        sensor: "error_rate",
        value: 0.5,
        limit: 0.2,
        direction: "above",
      },
      suggestedCapabilities: ["notify_user"],
      context: {},
      emittedAt: 1,
    };

    const plan = await planner.plan(trigger, {
      tools: [],
      agents: [],
      schedules: [],
    });

    expect(plan).toEqual({
      triggerId: "gov-1",
      steps: [
        {
          kind: "notify_user",
          channel: "inbox",
          message: "Threshold crossed",
          priority: "high",
        },
      ],
      estimatedCost: 2,
      requiresApproval: false,
    });
  });

  test("malformed JSON falls back to the rule planner when configured", async () => {
    const planner = createLlmCompositionPlanner({
      adapter: {
        async plan(): Promise<string> {
          return "{bad json";
        },
      },
      fallbackToRulePlanner: createRuleBasedCompositionPlanner(),
    });

    const trigger: CompositionTrigger = {
      id: "gov-1",
      source: "governance",
      confidence: 1,
      moment: {
        kind: "threshold_crossed",
        sensor: "error_rate",
        value: 0.5,
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

    expect(plan.steps).toEqual([
      {
        kind: "spawn_agent",
        agentType: "diagnostic",
        input: {
          kind: "text",
          text: "Investigate elevated error_rate and summarize root causes.",
        },
        delivery: DEFAULT_DELIVERY_POLICY,
      },
      {
        kind: "notify_user",
        channel: "inbox",
        message: "Error rate crossed its configured threshold.",
        priority: "high",
      },
    ]);
    expect(plan.estimatedCost).toBe(6);
    expect(plan.requiresApproval).toBe(false);
  });

  test("trigger-id mismatch falls back to the rule planner when configured", async () => {
    const planner = createLlmCompositionPlanner({
      adapter: {
        async plan(): Promise<string> {
          return JSON.stringify({
            triggerId: "wrong-id",
            steps: [],
            estimatedCost: 0,
          });
        },
      },
      fallbackToRulePlanner: createRuleBasedCompositionPlanner(),
    });

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

    expect(plan).toEqual({
      triggerId: "event-1",
      steps: [],
      estimatedCost: 0,
      requiresApproval: true,
    });
  });

  test("parseable but schema-invalid JSON falls back to the rule planner when configured", async () => {
    const planner = createLlmCompositionPlanner({
      adapter: {
        async plan(): Promise<string> {
          return JSON.stringify({
            triggerId: "event-2",
            steps: "not-an-array",
            estimatedCost: 0,
          });
        },
      },
      fallbackToRulePlanner: createRuleBasedCompositionPlanner(),
    });

    const trigger: CompositionTrigger = {
      id: "event-2",
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

    expect(plan).toEqual({
      triggerId: "event-2",
      steps: [],
      estimatedCost: 0,
      requiresApproval: true,
    });
  });

  test("rejects nested invalid message input that previously slipped through", async () => {
    const planner = createLlmCompositionPlanner({
      adapter: {
        async plan(): Promise<string> {
          return JSON.stringify({
            triggerId: "bad-nested-1",
            steps: [
              {
                kind: "spawn_agent",
                agentType: "researcher",
                input: {
                  kind: "messages",
                  messages: [
                    {
                      content: [],
                      threadId: "t-1",
                      timestamp: 1,
                    },
                  ],
                },
                delivery: { kind: "deferred" },
              },
            ],
            estimatedCost: 5,
          });
        },
      },
    });

    const trigger: CompositionTrigger = {
      id: "bad-nested-1",
      source: "governance",
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

    await expect(
      planner.plan(trigger, {
        tools: [],
        agents: [],
        schedules: [],
      }),
    ).rejects.toThrow();
  });

  test("local approval recomputation overrides model-provided approval", async () => {
    const planner = createLlmCompositionPlanner({
      adapter: {
        async plan(): Promise<string> {
          return JSON.stringify({
            triggerId: "low-1",
            steps: [
              {
                kind: "notify_user",
                channel: "inbox",
                message: "Low confidence plan",
                priority: "normal",
              },
            ],
            estimatedCost: 1,
            requiresApproval: false,
          });
        },
      },
    });

    const trigger: CompositionTrigger = {
      id: "low-1",
      source: "governance",
      confidence: 0.1,
      moment: { kind: "capability_gap", missing: "diagnostics" },
      suggestedCapabilities: ["notify_user"],
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
        message: "Low confidence plan",
        priority: "normal",
      },
    ]);
    expect(plan.requiresApproval).toBe(true);
  });

  test("local classify logic errors are not silently replaced with fallback output", async () => {
    const planner = createLlmCompositionPlanner({
      adapter: {
        async plan(): Promise<string> {
          return JSON.stringify({
            triggerId: "local-bug-1",
            steps: [],
            estimatedCost: 0,
          });
        },
      },
      classifyNovelty(): boolean {
        throw new Error("novelty exploded");
      },
      fallbackToRulePlanner: createRuleBasedCompositionPlanner(),
    });

    const trigger: CompositionTrigger = {
      id: "local-bug-1",
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

    await expect(
      planner.plan(trigger, {
        tools: [],
        agents: [],
        schedules: [],
      }),
    ).rejects.toThrow("novelty exploded");
  });
});
