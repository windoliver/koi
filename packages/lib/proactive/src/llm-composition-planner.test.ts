import { describe, expect, test } from "bun:test";
import {
  type AgentDefinition,
  agentId,
  type CompositionTrigger,
} from "@koi/core";
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
            triggerEmittedAt: 1,
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
      triggerEmittedAt: 1,
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
        kind: "notify_user",
        channel: "inbox",
        message: "Error rate crossed its configured threshold.",
        priority: "high",
      },
    ]);
    // Rule planner emits only the safe notify step (diagnostic spawn
    // dropped until executor supports it), so the fallback plan is
    // auto-executable.
    expect(plan.requiresApproval).toBe(false);
  });

  test("empty LLM plan forces requiresApproval=true (executor rejects empty non-approval)", async () => {
    const planner = createLlmCompositionPlanner({
      adapter: {
        async plan(): Promise<string> {
          return JSON.stringify({
            triggerId: "trigger-empty",
            triggerEmittedAt: 1,
            steps: [],
            estimatedCost: 0,
          });
        },
      },
    });

    const plan = await planner.plan(
      {
        id: "trigger-empty",
        source: "test",
        confidence: 1,
        moment: { kind: "external_event", source: "x", eventType: "y" },
        suggestedCapabilities: [],
        context: {},
        emittedAt: 1,
      },
      { tools: [], agents: [], schedules: [] },
    );

    expect(plan.steps).toHaveLength(0);
    expect(plan.requiresApproval).toBe(true);
  });

  test("LLM plan with notify_user channel outside the safe set is forced to approval", async () => {
    const planner = createLlmCompositionPlanner({
      adapter: {
        async plan(): Promise<string> {
          return JSON.stringify({
            triggerId: "trigger-channel",
            triggerEmittedAt: 1,
            steps: [{ kind: "notify_user", channel: "slack", message: "hi", priority: "normal" }],
            estimatedCost: 1,
          });
        },
      },
    });

    const plan = await planner.plan(
      {
        id: "trigger-channel",
        source: "test",
        confidence: 1,
        moment: { kind: "external_event", source: "x", eventType: "y" },
        suggestedCapabilities: [],
        context: {},
        emittedAt: 1,
      },
      { tools: [], agents: [], schedules: [] },
    );

    expect(plan.requiresApproval).toBe(true);
  });

  test("LLM plan with stale triggerEmittedAt is rejected (no relabeling)", async () => {
    const planner = createLlmCompositionPlanner({
      adapter: {
        async plan(): Promise<string> {
          return JSON.stringify({
            triggerId: "trigger-stale",
            // Adapter authored against an older emission; current trigger
            // is emittedAt=2 (below). Without validation, the planner
            // would relabel this as current and silently execute stale work.
            triggerEmittedAt: 1,
            steps: [{ kind: "notify_user", channel: "inbox", message: "x", priority: "normal" }],
            estimatedCost: 1,
          });
        },
      },
    });

    await expect(
      planner.plan(
        {
          id: "trigger-stale",
          source: "test",
          confidence: 1,
          moment: { kind: "external_event", source: "x", eventType: "y" },
          suggestedCapabilities: [],
          context: {},
          emittedAt: 2,
        },
        { tools: [], agents: [], schedules: [] },
      ),
    ).rejects.toThrow(/triggerEmittedAt mismatch/);
  });

  test("LLM plan without triggerEmittedAt back-compat: synthesize from current trigger", async () => {
    const planner = createLlmCompositionPlanner({
      adapter: {
        async plan(): Promise<string> {
          // Pre-emittedAt adapter contract: no triggerEmittedAt field.
          return JSON.stringify({
            triggerId: "trigger-legacy",
            steps: [{ kind: "notify_user", channel: "inbox", message: "hi", priority: "normal" }],
            estimatedCost: 1,
          });
        },
      },
    });

    const plan = await planner.plan(
      {
        id: "trigger-legacy",
        source: "test",
        confidence: 1,
        moment: { kind: "external_event", source: "x", eventType: "y" },
        suggestedCapabilities: [],
        context: {},
        emittedAt: 42,
      },
      { tools: [], agents: [], schedules: [] },
    );

    expect(plan.triggerEmittedAt).toBe(42);
  });

  test("planner config can disable Temporal-style gating for non-Temporal backends", async () => {
    const planner = createLlmCompositionPlanner({
      adapter: {
        async plan(): Promise<string> {
          return JSON.stringify({
            triggerId: "trigger-flex",
            triggerEmittedAt: 1,
            steps: [
              {
                kind: "submit_task",
                agentId: "agent-1",
                mode: "spawn",
                input: { kind: "text", text: "go" },
                taskOptions: { maxRetries: 3 },
              },
              { kind: "notify_user", channel: "slack", message: "x", priority: "normal" },
            ],
            estimatedCost: 1,
          });
        },
      },
      // In-process scheduler accepts maxRetries; host has wired the
      // slack channel into the executor's allowedNotifyChannels.
      unsafeSubmitOptionKeys: [],
      unsafeScheduleOptionKeys: [],
      safeNotifyChannels: ["inbox", "slack"],
    });

    const plan = await planner.plan(
      {
        id: "trigger-flex",
        source: "test",
        confidence: 1,
        moment: { kind: "external_event", source: "x", eventType: "y" },
        suggestedCapabilities: [],
        context: {},
        emittedAt: 1,
      },
      { tools: [], agents: [], schedules: [] },
    );

    expect(plan.requiresApproval).toBe(false);
  });

  test("LLM plan with submit_task unsupported taskOptions is forced to approval", async () => {
    const planner = createLlmCompositionPlanner({
      adapter: {
        async plan(): Promise<string> {
          return JSON.stringify({
            triggerId: "trigger-submit",
            triggerEmittedAt: 1,
            steps: [
              {
                kind: "submit_task",
                agentId: "agent-1",
                mode: "spawn",
                input: { kind: "text", text: "go" },
                taskOptions: { maxRetries: 3 },
              },
            ],
            estimatedCost: 1,
          });
        },
      },
    });

    const plan = await planner.plan(
      {
        id: "trigger-submit",
        source: "test",
        confidence: 1,
        moment: { kind: "external_event", source: "x", eventType: "y" },
        suggestedCapabilities: [],
        context: {},
        emittedAt: 1,
      },
      { tools: [], agents: [], schedules: [] },
    );

    expect(plan.requiresApproval).toBe(true);
  });

  test("LLM plan with create_schedule unsupported taskOptions is forced to approval", async () => {
    const planner = createLlmCompositionPlanner({
      adapter: {
        async plan(): Promise<string> {
          return JSON.stringify({
            triggerId: "trigger-sched",
            triggerEmittedAt: 1,
            steps: [
              {
                kind: "create_schedule",
                expression: "0 9 * * *",
                agentId: "agent-1",
                mode: "spawn",
                input: { kind: "text", text: "daily" },
                taskOptions: { maxRetries: 2 },
              },
            ],
            estimatedCost: 1,
          });
        },
      },
    });

    const plan = await planner.plan(
      {
        id: "trigger-sched",
        source: "test",
        confidence: 1,
        moment: { kind: "external_event", source: "x", eventType: "y" },
        suggestedCapabilities: [],
        context: {},
        emittedAt: 1,
      },
      { tools: [], agents: [], schedules: [] },
    );

    expect(plan.requiresApproval).toBe(true);
  });

  test("LLM plan with unsupported-before-supported is forced to approval", async () => {
    const planner = createLlmCompositionPlanner({
      adapter: {
        async plan(): Promise<string> {
          return JSON.stringify({
            triggerId: "trigger-1",
            triggerEmittedAt: 1,
            // Adversarial ordering: unsupported step BEFORE the
            // user-facing notification. Executor fail-closes on
            // unsupported, so without normalization the notify drops.
            steps: [
              {
                kind: "spawn_agent",
                agentType: "diagnostic",
                input: { kind: "text", text: "diagnose" },
                delivery: { kind: "deferred" },
              },
              { kind: "notify_user", channel: "inbox", message: "alert", priority: "high" },
            ],
            estimatedCost: 6,
          });
        },
      },
    });

    const plan = await planner.plan(
      {
        id: "trigger-1",
        source: "test",
        confidence: 1,
        moment: { kind: "external_event", source: "x", eventType: "y" },
        suggestedCapabilities: [],
        context: {},
        emittedAt: 1,
      },
      { tools: [], agents: [], schedules: [] },
    );

    // Order is preserved (no semantic-changing reorder), but the plan is
    // forced through approval so the unsupported leading step doesn't
    // silently swallow the supported notification.
    expect(plan.steps[0]?.kind).toBe("spawn_agent");
    expect(plan.steps[1]?.kind).toBe("notify_user");
    expect(plan.requiresApproval).toBe(true);
  });

  test("trigger-id mismatch falls back to the rule planner when configured", async () => {
    const planner = createLlmCompositionPlanner({
      adapter: {
        async plan(): Promise<string> {
          return JSON.stringify({
            triggerId: "wrong-id",
            triggerEmittedAt: 1,
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
      triggerEmittedAt: 1,
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
            triggerEmittedAt: 1,
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
      triggerEmittedAt: 1,
      steps: [],
      estimatedCost: 0,
      requiresApproval: true,
    });
  });

  test("negative estimated cost is rejected and can fall back to the rule planner", async () => {
    const planner = createLlmCompositionPlanner({
      adapter: {
        async plan(): Promise<string> {
          return JSON.stringify({
            triggerId: "event-3",
            triggerEmittedAt: 1,
            steps: [],
            estimatedCost: -1,
          });
        },
      },
      fallbackToRulePlanner: createRuleBasedCompositionPlanner(),
    });

    const trigger: CompositionTrigger = {
      id: "event-3",
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
      triggerId: "event-3",
      triggerEmittedAt: 1,
      steps: [],
      estimatedCost: 0,
      requiresApproval: true,
    });
  });

  test("fallback plans are reclassified with the outer llm approval policy", async () => {
    const planner = createLlmCompositionPlanner({
      adapter: {
        async plan(): Promise<string> {
          return "{bad json";
        },
      },
      approvalPolicy: {
        confidenceThreshold: 0,
        maxEstimatedCost: 100,
        requireApprovalOnNovelty: true,
      },
      classifyNovelty(): boolean {
        return true;
      },
      fallbackToRulePlanner: createRuleBasedCompositionPlanner({
        approvalPolicy: {
          confidenceThreshold: 0,
          maxEstimatedCost: 100,
          requireApprovalOnNovelty: false,
        },
      }),
    });

    const trigger: CompositionTrigger = {
      id: "gov-novel-1",
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
        kind: "notify_user",
        channel: "inbox",
        message: "Error rate crossed its configured threshold.",
        priority: "high",
      },
    ]);
    // Outer LLM policy reclassifies: classifyNovelty=true +
    // requireApprovalOnNovelty=true forces approval even though the
    // fallback plan would auto-execute under the inner rule policy.
    expect(plan.requiresApproval).toBe(true);
  });

  test("rejects nested invalid message input that previously slipped through", async () => {
    const planner = createLlmCompositionPlanner({
      adapter: {
        async plan(): Promise<string> {
          return JSON.stringify({
            triggerId: "bad-nested-1",
            triggerEmittedAt: 1,
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
            triggerEmittedAt: 1,
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

  test("round-trips tool_call step kind", async () => {
    const planner = createLlmCompositionPlanner({
      adapter: {
        async plan(): Promise<string> {
          return JSON.stringify({
            triggerId: "tc-1",
            triggerEmittedAt: 1,
            steps: [
              {
                kind: "tool_call",
                toolName: "search",
                input: { query: "needle" },
              },
            ],
            estimatedCost: 2,
          });
        },
      },
    });

    const trigger: CompositionTrigger = {
      id: "tc-1",
      source: "external",
      confidence: 1,
      moment: { kind: "external_event", source: "slack", eventType: "mention" },
      suggestedCapabilities: ["tool_call"],
      context: {},
      emittedAt: 1,
    };

    const plan = await planner.plan(trigger, { tools: [], agents: [], schedules: [] });
    expect(plan.steps).toEqual([
      { kind: "tool_call", toolName: "search", input: { query: "needle" } },
    ]);
  });

  test("round-trips submit_task step kind", async () => {
    const planner = createLlmCompositionPlanner({
      adapter: {
        async plan(): Promise<string> {
          return JSON.stringify({
            triggerId: "st-1",
            triggerEmittedAt: 1,
            steps: [
              {
                kind: "submit_task",
                agentId: "agent-42",
                mode: "dispatch",
                input: { kind: "text", text: "process queue" },
                taskOptions: { priority: 5, timeoutMs: 30000 },
              },
            ],
            estimatedCost: 3,
          });
        },
      },
    });

    const expectedAgentId = agentId("agent-42");
    const trigger: CompositionTrigger = {
      id: "st-1",
      source: "external",
      confidence: 1,
      moment: { kind: "external_event", source: "slack", eventType: "mention" },
      suggestedCapabilities: ["submit_task"],
      context: {},
      emittedAt: 1,
    };

    const plan = await planner.plan(trigger, { tools: [], agents: [], schedules: [] });
    expect(plan.steps).toEqual([
      {
        kind: "submit_task",
        agentId: expectedAgentId,
        mode: "dispatch",
        input: { kind: "text", text: "process queue" },
        taskOptions: { priority: 5, timeoutMs: 30000 },
      },
    ]);
  });

  test("round-trips create_schedule step kind", async () => {
    const planner = createLlmCompositionPlanner({
      adapter: {
        async plan(): Promise<string> {
          return JSON.stringify({
            triggerId: "cs-1",
            triggerEmittedAt: 1,
            steps: [
              {
                kind: "create_schedule",
                expression: "0 9 * * *",
                agentId: "agent-1",
                mode: "spawn",
                input: { kind: "text", text: "daily standup" },
                timezone: "America/Los_Angeles",
              },
            ],
            estimatedCost: 3,
          });
        },
      },
    });

    const trigger: CompositionTrigger = {
      id: "cs-1",
      source: "external",
      confidence: 1,
      moment: { kind: "external_event", source: "cron", eventType: "setup" },
      suggestedCapabilities: ["create_schedule"],
      context: {},
      emittedAt: 1,
    };

    const plan = await planner.plan(trigger, { tools: [], agents: [], schedules: [] });
    expect(plan.steps).toEqual([
      {
        kind: "create_schedule",
        expression: "0 9 * * *",
        agentId: agentId("agent-1"),
        mode: "spawn",
        input: { kind: "text", text: "daily standup" },
        timezone: "America/Los_Angeles",
      },
    ]);
  });

  test("round-trips forge_skill step kind", async () => {
    const planner = createLlmCompositionPlanner({
      adapter: {
        async plan(): Promise<string> {
          return JSON.stringify({
            triggerId: "fs-1",
            triggerEmittedAt: 100,
            steps: [
              {
                kind: "forge_skill",
                demand: {
                  id: "demand-1",
                  kind: "forge_demand",
                  trigger: { kind: "capability_gap", requiredCapability: "csv-parse" },
                  confidence: 0.9,
                  suggestedBrickKind: "skill",
                  context: {
                    failureCount: 3,
                    failedToolCalls: ["read_file:csv"],
                    taskDescription: "parse quarterly report",
                  },
                  emittedAt: 100,
                },
              },
            ],
            estimatedCost: 4,
          });
        },
      },
    });

    const trigger: CompositionTrigger = {
      id: "fs-1",
      source: "forge_demand",
      confidence: 1,
      moment: { kind: "capability_gap", missing: "csv-parse" },
      suggestedCapabilities: ["forge_skill"],
      context: {},
      emittedAt: 100,
    };

    const plan = await planner.plan(trigger, { tools: [], agents: [], schedules: [] });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({
      kind: "forge_skill",
      demand: { id: "demand-1", suggestedBrickKind: "skill" },
    });
  });

  test("local classify logic errors are not silently replaced with fallback output", async () => {
    const planner = createLlmCompositionPlanner({
      adapter: {
        async plan(): Promise<string> {
          return JSON.stringify({
            triggerId: "local-bug-1",
            triggerEmittedAt: 1,
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
