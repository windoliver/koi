import type {
  CompositionApprovalPolicy,
  CompositionCapabilities,
  CompositionPlan,
  CompositionPlanner,
  CompositionStep,
  CompositionTrigger,
} from "@koi/core";
import { z } from "zod";
import {
  computeCompositionApproval,
  DEFAULT_COMPOSITION_APPROVAL_POLICY,
} from "./composition-approval.js";

class AdapterPlanParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AdapterPlanParseError";
  }
}

export interface CompositionPlannerAdapterInput {
  readonly trigger: CompositionTrigger;
  readonly capabilities: CompositionCapabilities;
}

export interface CompositionPlannerAdapter {
  readonly plan: (input: CompositionPlannerAdapterInput) => Promise<string>;
}

export interface LlmCompositionPlannerConfig {
  readonly adapter: CompositionPlannerAdapter;
  readonly approvalPolicy?: CompositionApprovalPolicy | undefined;
  readonly classifyNovelty?: ((trigger: CompositionTrigger) => boolean) | undefined;
  readonly fallbackToRulePlanner?: CompositionPlanner | undefined;
}

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    metadataSchema,
  ]),
);

const metadataSchema: z.ZodType<Readonly<Record<string, unknown>>> = z.record(
  z.string(),
  jsonValueSchema,
);

const contentBlockSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }).strict(),
  z
    .object({
      kind: z.literal("file"),
      url: z.string(),
      mimeType: z.string(),
      name: z.string().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("image"), url: z.string(), alt: z.string().optional() }).strict(),
  z
    .object({
      kind: z.literal("button"),
      label: z.string(),
      action: z.string(),
      payload: jsonValueSchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("custom"), type: z.string(), data: jsonValueSchema }).strict(),
]);

const inboundMessageSchema = z
  .object({
    content: z.array(contentBlockSchema),
    senderId: z.string(),
    threadId: z.string().optional(),
    timestamp: z.number(),
    metadata: metadataSchema.optional(),
    pinned: z.boolean().optional(),
  })
  .strict();

const taskOptionsSchema = z
  .object({
    priority: z.number().optional(),
    delayMs: z.number().optional(),
    maxRetries: z.number().optional(),
    timeoutMs: z.number().optional(),
    metadata: metadataSchema.optional(),
    idempotencyKey: z.string().optional(),
  })
  .strict();

const deliveryPolicySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("streaming") }).strict(),
  z
    .object({
      kind: z.literal("deferred"),
      inboxMode: z
        .union([z.literal("collect"), z.literal("followup"), z.literal("steer")])
        .optional(),
    })
    .strict(),
  z.object({ kind: z.literal("on_demand") }).strict(),
]);

const engineInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }).strict(),
  z.object({ kind: z.literal("messages"), messages: z.array(inboundMessageSchema) }).strict(),
  z
    .object({
      kind: z.literal("resume"),
      state: z.object({ engineId: z.string(), data: jsonValueSchema }).strict(),
    })
    .strict(),
]);

const forgeTriggerSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("repeated_failure"), toolName: z.string(), count: z.number() })
    .strict(),
  z
    .object({
      kind: z.literal("no_matching_tool"),
      query: z.string(),
      attempts: z.number(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("capability_gap"),
      requiredCapability: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("performance_degradation"),
      toolName: z.string(),
      metric: z.string(),
    })
    .strict(),
  z.object({ kind: z.literal("agent_capability_gap"), agentType: z.string() }).strict(),
  z
    .object({
      kind: z.literal("agent_repeated_failure"),
      agentType: z.string(),
      brickId: z.string(),
      errorRate: z.number(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("agent_latency_degradation"),
      agentType: z.string(),
      brickId: z.string(),
      p95Ms: z.number(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("data_source_detected"),
      sourceName: z.string(),
      protocol: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("data_source_gap"),
      sourceName: z.string(),
      missingCapability: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("complex_task_completed"),
      toolCallCount: z.number(),
      taskDescription: z.string(),
      toolsUsed: z.array(z.string()),
      turnCount: z.number(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("user_correction"),
      correctionText: z.string(),
      correctedToolCall: z.string(),
      correctionDescription: z.string(),
      originalToolName: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("novel_workflow"),
      workflowDescription: z.string(),
      toolSequence: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      kind: z.literal("composition_gap"),
      requiredCapability: z.string(),
      observedCount: z.number(),
    })
    .strict(),
]);

const forgeDemandSchema = z
  .object({
    id: z.string(),
    kind: z.literal("forge_demand"),
    trigger: forgeTriggerSchema,
    confidence: z.number(),
    suggestedBrickKind: z.union([
      z.literal("tool"),
      z.literal("skill"),
      z.literal("agent"),
      z.literal("middleware"),
      z.literal("channel"),
      z.literal("composite"),
    ]),
    context: z
      .object({
        failureCount: z.number(),
        failedToolCalls: z.array(z.string()),
        taskDescription: z.string().optional(),
      })
      .strict(),
    emittedAt: z.number(),
  })
  .strict();

const compositionStepSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("tool_call"),
      toolName: z.string(),
      input: z.unknown(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("spawn_agent"),
      agentType: z.string(),
      input: engineInputSchema,
      delivery: deliveryPolicySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("submit_task"),
      agentId: z.string(),
      mode: z.union([z.literal("spawn"), z.literal("dispatch")]),
      input: engineInputSchema,
      taskOptions: taskOptionsSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("create_schedule"),
      expression: z.string(),
      agentId: z.string(),
      mode: z.union([z.literal("spawn"), z.literal("dispatch")]),
      input: engineInputSchema,
      timezone: z.string().optional(),
      taskOptions: taskOptionsSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("forge_skill"),
      demand: forgeDemandSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("notify_user"),
      channel: z.string(),
      message: z.string(),
      priority: z.union([z.literal("low"), z.literal("normal"), z.literal("high")]),
    })
    .strict(),
]);

const llmPlanSchema = z
  .object({
    triggerId: z.string(),
    steps: z.array(compositionStepSchema),
    estimatedCost: z.number().finite().nonnegative(),
  })
  .passthrough();

// Step kinds the executor currently does not run; the executor fail-closes
// on the first such step.
const EXECUTOR_UNSUPPORTED_KINDS = new Set<string>([
  "spawn_agent",
  "forge_skill",
  "tool_call",
]);

// True when an unsupported step appears BEFORE any supported step. In that
// case the executor will fail-closed on the unsupported step and never
// reach the supported one. Reordering the plan would change semantics
// (notifications could fire before the prerequisite analysis runs), so the
// LLM planner instead routes such plans through approval — a human/policy
// then decides whether to dispatch the supported suffix manually, drop the
// plan, or wait for unsupported-step support.
function hasUnsupportedBeforeSupported(steps: readonly CompositionStep[]): boolean {
  let sawUnsupported = false;
  for (const step of steps) {
    if (EXECUTOR_UNSUPPORTED_KINDS.has(step.kind)) sawUnsupported = true;
    else if (sawUnsupported) return true;
  }
  return false;
}

function parseAdapterResponse(
  raw: string,
  trigger: CompositionTrigger,
): Omit<CompositionPlan, "requiresApproval"> {
  try {
    const normalized = raw
      .trim()
      .replace(/^```(?:json)?\s*/u, "")
      .replace(/\s*```$/u, "")
      .trim();

    const parsed = JSON.parse(normalized) as unknown;
    const plan = llmPlanSchema.parse(parsed);

    if (plan.triggerId !== trigger.id) {
      throw new AdapterPlanParseError(
        `planner triggerId mismatch: expected ${trigger.id}, got ${plan.triggerId}`,
      );
    }

    return {
      triggerId: plan.triggerId,
      triggerEmittedAt: trigger.emittedAt,
      steps: plan.steps as readonly CompositionStep[],
      estimatedCost: plan.estimatedCost,
    };
  } catch (error) {
    if (error instanceof AdapterPlanParseError) throw error;
    throw new AdapterPlanParseError("adapter returned an invalid composition plan", {
      cause: error,
    });
  }
}

function withComputedApproval(
  plan: Omit<CompositionPlan, "requiresApproval">,
  trigger: CompositionTrigger,
  approvalPolicy: CompositionApprovalPolicy,
  isNovel: boolean,
): CompositionPlan {
  // Empty plans are forced through the approval path. The executor rejects
  // zero-step non-approval plans as INVALID_PLAN, so without this guard an
  // adapter response with `steps: []` (or a fallback path that returns
  // none) would planner-as-executable but fail deterministically at run.
  // Routing to approval lets a human/policy decide what to do instead of
  // surfacing as a planner/executor mismatch.
  if (plan.steps.length === 0) {
    return { ...plan, requiresApproval: true };
  }
  // Plans where an executor-unsupported step (spawn_agent/forge_skill/
  // tool_call) precedes a supported one are also forced to approval.
  // The executor fail-closes on the first unsupported step, so without
  // gating the supported suffix would silently drop. Reordering the plan
  // would change semantics (notify before prerequisite ran), so we
  // require human adjudication instead.
  if (hasUnsupportedBeforeSupported(plan.steps)) {
    return { ...plan, requiresApproval: true };
  }
  return {
    ...plan,
    requiresApproval: computeCompositionApproval(trigger, plan.estimatedCost, approvalPolicy, {
      isNovel,
    }),
  };
}

export function createLlmCompositionPlanner(
  config: LlmCompositionPlannerConfig,
): CompositionPlanner {
  const approvalPolicy = config.approvalPolicy ?? DEFAULT_COMPOSITION_APPROVAL_POLICY;
  const classifyNovelty = config.classifyNovelty ?? (() => false);

  return {
    async plan(trigger, capabilities): Promise<CompositionPlan> {
      const isNovel = classifyNovelty(trigger);
      let parsed: Omit<CompositionPlan, "requiresApproval">;
      try {
        const raw = await config.adapter.plan({ trigger, capabilities });
        parsed = parseAdapterResponse(raw, trigger);
      } catch (error) {
        if (config.fallbackToRulePlanner !== undefined && error instanceof AdapterPlanParseError) {
          const fallbackPlan = await config.fallbackToRulePlanner.plan(trigger, capabilities);
          return withComputedApproval(fallbackPlan, trigger, approvalPolicy, isNovel);
        }
        throw error;
      }

      return withComputedApproval(parsed, trigger, approvalPolicy, isNovel);
    },
  };
}
