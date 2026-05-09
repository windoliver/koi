import {
  type CompositionApprovalPolicy,
  type CompositionCapabilities,
  type CompositionPlan,
  type CompositionPlanner,
  type CompositionStep,
  type CompositionTrigger,
  DEFAULT_DELIVERY_POLICY,
  type ForgeDemandSignal,
} from "@koi/core";
import {
  computeCompositionApproval,
  DEFAULT_COMPOSITION_APPROVAL_POLICY,
} from "./composition-approval.js";

export interface RuleBasedCompositionPlannerConfig {
  readonly approvalPolicy?: CompositionApprovalPolicy | undefined;
  readonly classifyNovelty?: ((trigger: CompositionTrigger) => boolean) | undefined;
}

function estimateStepCost(step: CompositionStep): number {
  switch (step.kind) {
    case "notify_user":
      return 1;
    case "tool_call":
      return 2;
    case "submit_task":
    case "create_schedule":
      return 3;
    case "forge_skill":
      return 4;
    case "spawn_agent":
      return 5;
  }

  const _exhaustive: never = step;
  return _exhaustive;
}

function estimateCost(steps: readonly CompositionStep[]): number {
  return steps.reduce((total, step) => total + estimateStepCost(step), 0);
}

function isForgeDemandSignal(value: unknown): value is ForgeDemandSignal {
  if (typeof value !== "object" || value === null) return false;

  const demand = value as Record<string, unknown>;
  const context = demand.context;
  const trigger = demand.trigger;

  return (
    typeof demand.id === "string" &&
    demand.kind === "forge_demand" &&
    typeof demand.confidence === "number" &&
    Number.isFinite(demand.confidence) &&
    typeof demand.suggestedBrickKind === "string" &&
    typeof demand.emittedAt === "number" &&
    Number.isFinite(demand.emittedAt) &&
    typeof trigger === "object" &&
    trigger !== null &&
    typeof (trigger as Record<string, unknown>).kind === "string" &&
    typeof context === "object" &&
    context !== null &&
    typeof (context as Record<string, unknown>).failureCount === "number" &&
    Array.isArray((context as Record<string, unknown>).failedToolCalls)
  );
}

function getForgeDemand(trigger: CompositionTrigger): ForgeDemandSignal | undefined {
  const demand = trigger.context.forgeDemand;
  if (!isForgeDemandSignal(demand)) return undefined;
  return demand;
}

function hasAgentType(capabilities: CompositionCapabilities, agentType: string): boolean {
  return capabilities.agents.some((agent) => agent.agentType === agentType);
}

function isRepresentableSkillForgeDemand(
  trigger: CompositionTrigger,
): ForgeDemandSignal | undefined {
  const demand = getForgeDemand(trigger);
  if (demand?.suggestedBrickKind !== "skill") return undefined;
  return demand;
}

function stepsForCapabilityGap(trigger: CompositionTrigger): readonly CompositionStep[] {
  const forgeDemand = isRepresentableSkillForgeDemand(trigger);
  return forgeDemand === undefined ? [] : [{ kind: "forge_skill", demand: forgeDemand }];
}

function stepsForThresholdCrossed(
  trigger: CompositionTrigger,
  capabilities: CompositionCapabilities,
): readonly CompositionStep[] {
  if (
    trigger.moment.kind !== "threshold_crossed" ||
    trigger.moment.sensor !== "error_rate" ||
    trigger.moment.direction !== "above"
  ) {
    return [];
  }
  const steps: CompositionStep[] = [];
  // notify_user FIRST so the operator-facing notification fires even when
  // a later spawn_agent step is unsupported by the executor: the executor
  // fail-closes on the first unsupported step, so any safe-to-run user
  // notification must precede unsupported diagnostic spawning.
  steps.push({
    kind: "notify_user",
    channel: "inbox",
    message: "Error rate crossed its configured threshold.",
    priority: "high",
  });
  if (hasAgentType(capabilities, "diagnostic")) {
    steps.push({
      kind: "spawn_agent",
      agentType: "diagnostic",
      input: {
        kind: "text",
        text: "Investigate elevated error_rate and summarize root causes.",
      },
      delivery: DEFAULT_DELIVERY_POLICY,
    });
  }
  return steps;
}

function stepsForTaskTerminal(
  trigger: CompositionTrigger,
  capabilities: CompositionCapabilities,
): readonly CompositionStep[] {
  if (trigger.moment.kind !== "task_terminal") return [];
  const { outcome, taskId } = trigger.moment;
  if (
    (outcome !== "failed" && outcome !== "dead_letter") ||
    !hasAgentType(capabilities, "recovery")
  ) {
    return [];
  }
  return [
    {
      kind: "spawn_agent",
      agentType: "recovery",
      input: {
        kind: "text",
        text: `Analyze failed scheduled task ${String(taskId)} and propose recovery.`,
      },
      delivery: DEFAULT_DELIVERY_POLICY,
    },
  ];
}

function stepsForFrontierChanged(
  trigger: CompositionTrigger,
  capabilities: CompositionCapabilities,
): readonly CompositionStep[] {
  if (trigger.moment.kind !== "frontier_changed" || !hasAgentType(capabilities, "researcher")) {
    return [];
  }
  return [
    {
      kind: "spawn_agent",
      agentType: "researcher",
      input: {
        kind: "text",
        text: `Investigate frontier change in ${trigger.moment.metric}.`,
      },
      delivery: { kind: "deferred" },
    },
  ];
}

function stepsForTrigger(
  trigger: CompositionTrigger,
  capabilities: CompositionCapabilities,
): readonly CompositionStep[] {
  switch (trigger.moment.kind) {
    case "capability_gap":
      return stepsForCapabilityGap(trigger);
    case "threshold_crossed":
      return stepsForThresholdCrossed(trigger, capabilities);
    case "task_terminal":
      return stepsForTaskTerminal(trigger, capabilities);
    case "frontier_changed":
      return stepsForFrontierChanged(trigger, capabilities);
    case "pattern_matched":
    case "external_event":
      return [];
  }
}

// Step kinds the composition executor currently does not run; auto-
// approving plans containing any of these would deterministically fail
// at execute time. Force them through approval so unsupported automation
// is gated rather than silently failing.
const EXECUTOR_UNSUPPORTED_KINDS = new Set<string>([
  "spawn_agent",
  "forge_skill",
  "tool_call",
]);

function planContainsUnsupported(steps: readonly CompositionStep[]): boolean {
  for (const step of steps) {
    if (EXECUTOR_UNSUPPORTED_KINDS.has(step.kind)) return true;
  }
  return false;
}

export function createRuleBasedCompositionPlanner(
  config: RuleBasedCompositionPlannerConfig = {},
): CompositionPlanner {
  const approvalPolicy = config.approvalPolicy ?? DEFAULT_COMPOSITION_APPROVAL_POLICY;
  const classifyNovelty = config.classifyNovelty ?? (() => false);

  return {
    async plan(trigger, capabilities): Promise<CompositionPlan> {
      const steps = stepsForTrigger(trigger, capabilities);
      const estimatedCost = estimateCost(steps);
      return {
        triggerId: trigger.id,
        triggerEmittedAt: trigger.emittedAt,
        steps,
        estimatedCost,
        requiresApproval:
          steps.length === 0 ||
          planContainsUnsupported(steps) ||
          computeCompositionApproval(trigger, estimatedCost, approvalPolicy, {
            isNovel: classifyNovelty(trigger),
          }),
      };
    },
  };
}
