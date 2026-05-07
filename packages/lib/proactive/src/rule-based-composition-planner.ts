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

export function createRuleBasedCompositionPlanner(
  config: RuleBasedCompositionPlannerConfig = {},
): CompositionPlanner {
  const approvalPolicy = config.approvalPolicy ?? DEFAULT_COMPOSITION_APPROVAL_POLICY;
  const classifyNovelty = config.classifyNovelty ?? (() => false);

  return {
    async plan(trigger, capabilities): Promise<CompositionPlan> {
      const steps: CompositionStep[] = [];

      switch (trigger.moment.kind) {
        case "capability_gap": {
          const forgeDemand = isRepresentableSkillForgeDemand(trigger);
          if (forgeDemand !== undefined) {
            steps.push({ kind: "forge_skill", demand: forgeDemand });
          }
          break;
        }
        case "threshold_crossed":
          if (trigger.moment.sensor === "error_rate" && trigger.moment.direction === "above") {
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
            steps.push({
              kind: "notify_user",
              channel: "inbox",
              message: "Error rate crossed its configured threshold.",
              priority: "high",
            });
          }
          break;
        case "task_terminal":
          if (
            (trigger.moment.outcome === "failed" || trigger.moment.outcome === "dead_letter") &&
            hasAgentType(capabilities, "recovery")
          ) {
            steps.push({
              kind: "spawn_agent",
              agentType: "recovery",
              input: {
                kind: "text",
                text: `Analyze failed scheduled task ${String(trigger.moment.taskId)} and propose recovery.`,
              },
              delivery: DEFAULT_DELIVERY_POLICY,
            });
          }
          break;
        case "frontier_changed":
          if (hasAgentType(capabilities, "researcher")) {
            steps.push({
              kind: "spawn_agent",
              agentType: "researcher",
              input: {
                kind: "text",
                text: `Investigate frontier change in ${trigger.moment.metric}.`,
              },
              delivery: { kind: "deferred" },
            });
          }
          break;
        case "pattern_matched":
        case "external_event":
          break;
      }

      const estimatedCost = estimateCost(steps);

      return {
        triggerId: trigger.id,
        steps,
        estimatedCost,
        requiresApproval:
          steps.length === 0 ||
          computeCompositionApproval(trigger, estimatedCost, approvalPolicy, {
            isNovel: classifyNovelty(trigger),
          }),
      };
    },
  };
}
