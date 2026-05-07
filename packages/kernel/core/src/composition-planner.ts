/**
 * Composition planning contracts — shared L0 vocabulary for proactive planning.
 *
 * These types define the normalized trigger, plan, and approval surface used by
 * downstream planner implementations. No runtime logic lives here.
 */

import type { AgentDefinition } from "./agent-definition.js";
import type { ForgeStore } from "./brick-store.js";
import type { DeliveryPolicy } from "./delivery.js";
import type { AgentId, ToolDescriptor } from "./ecs.js";
import type { EngineInput } from "./engine.js";
import type { ForgeDemandSignal } from "./forge-demand.js";
import type { CronSchedule, TaskId, TaskOptions } from "./scheduler.js";

// ---------------------------------------------------------------------------
// Trigger vocabulary
// ---------------------------------------------------------------------------

export interface CompositionTrigger {
  readonly id: string;
  readonly source: string;
  readonly confidence: number;
  readonly moment: CompositionMoment;
  readonly suggestedCapabilities: readonly string[];
  readonly context: Readonly<Record<string, unknown>>;
  readonly emittedAt: number;
}

export type CompositionMoment =
  | { readonly kind: "capability_gap"; readonly missing: string }
  | {
      readonly kind: "threshold_crossed";
      readonly sensor: string;
      readonly value: number;
      readonly limit: number;
      readonly direction: "above" | "below";
    }
  | { readonly kind: "pattern_matched"; readonly patternId: string; readonly description: string }
  | {
      readonly kind: "task_terminal";
      readonly taskId: TaskId;
      readonly outcome: "completed" | "failed" | "dead_letter" | "cancelled";
    }
  | { readonly kind: "external_event"; readonly source: string; readonly eventType: string }
  | { readonly kind: "frontier_changed"; readonly metric: string; readonly improvement: number };

// ---------------------------------------------------------------------------
// Capabilities and plan shapes
// ---------------------------------------------------------------------------

export interface CompositionCapabilities {
  readonly tools: readonly ToolDescriptor[];
  readonly agents: readonly AgentDefinition[];
  readonly schedules: readonly CronSchedule[];
  readonly forgeStore?: ForgeStore | undefined;
}

export interface CompositionPlan {
  readonly triggerId: string;
  readonly steps: readonly CompositionStep[];
  readonly estimatedCost: number;
  readonly requiresApproval: boolean;
}

export type CompositionStep =
  | { readonly kind: "tool_call"; readonly toolName: string; readonly input: unknown }
  | {
      readonly kind: "spawn_agent";
      readonly agentType: string;
      readonly input: EngineInput;
      readonly delivery: DeliveryPolicy;
    }
  | {
      readonly kind: "submit_task";
      readonly agentId: AgentId;
      readonly mode: "spawn" | "dispatch";
      readonly input: EngineInput;
      readonly taskOptions?: TaskOptions | undefined;
    }
  | {
      readonly kind: "create_schedule";
      readonly expression: string;
      readonly agentId: AgentId;
      readonly mode: "spawn" | "dispatch";
      readonly input: EngineInput;
      readonly timezone?: string | undefined;
      readonly taskOptions?: TaskOptions | undefined;
    }
  | { readonly kind: "forge_skill"; readonly demand: ForgeDemandSignal }
  | {
      readonly kind: "notify_user";
      readonly channel: string;
      readonly message: string;
      readonly priority: "low" | "normal" | "high";
    };

// ---------------------------------------------------------------------------
// Planner and approval contracts
// ---------------------------------------------------------------------------

export interface CompositionPlanner {
  readonly plan: (
    trigger: CompositionTrigger,
    capabilities: CompositionCapabilities,
  ) => Promise<CompositionPlan>;
}

export interface CompositionApprovalPolicy {
  readonly confidenceThreshold: number;
  readonly maxEstimatedCost: number;
  readonly requireApprovalOnNovelty: boolean;
}

export interface CompositionApprovalContext {
  readonly isNovel: boolean;
}
