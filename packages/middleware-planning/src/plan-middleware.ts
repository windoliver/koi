/**
 * Planning middleware factory — inject write_plan tool for structured task tracking.
 *
 * Priority 450 (default): runs after tool-selector (420), before soul (500).
 */

import type { JsonObject } from "@koi/core/common";
import type { InboundMessage } from "@koi/core/message";
import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core/middleware";
import { KoiRuntimeError } from "@koi/errors";
import { validatePlanConfig } from "./config.js";
import { PLAN_SYSTEM_PROMPT, WRITE_PLAN_DESCRIPTOR, WRITE_PLAN_TOOL_NAME } from "./plan-tool.js";
import type { PlanConfig, PlanItem, PlanStatus } from "./types.js";

const DEFAULT_PRIORITY = 450;
const VALID_STATUSES = new Set<string>(["pending", "in_progress", "completed"]);

/** The system message injected to instruct the model about planning. */
const PLAN_SYSTEM_MESSAGE: InboundMessage = {
  senderId: "system:plan",
  timestamp: 0,
  content: [{ kind: "text", text: PLAN_SYSTEM_PROMPT }],
};

/**
 * Creates a planning middleware that injects a `write_plan` tool and
 * intercepts its calls to maintain a structured plan across turns.
 */
export function createPlanMiddleware(config?: PlanConfig): KoiMiddleware {
  const validResult = validatePlanConfig(config);
  if (!validResult.ok) {
    throw KoiRuntimeError.from(validResult.error.code, validResult.error.message);
  }

  const validated = validResult.value;
  const priority = validated.priority ?? DEFAULT_PRIORITY;
  const onPlanUpdate = validated.onPlanUpdate;

  // Closure state — persists across turns
  // let justified: plan state that changes on each write_plan call
  let currentPlan: readonly PlanItem[] = [];
  // let justified: per-turn counter reset in onBeforeTurn
  let writePlanCallsThisTurn = 0;

  /** Enrich a model request with the plan system message and tool descriptor. */
  function enrichRequest(request: ModelRequest): ModelRequest {
    const messages = [PLAN_SYSTEM_MESSAGE, ...request.messages];
    const tools =
      request.tools !== undefined
        ? [...request.tools, WRITE_PLAN_DESCRIPTOR]
        : [WRITE_PLAN_DESCRIPTOR];
    return { ...request, messages, tools };
  }

  /** Validate and parse plan items from tool input. */
  function parsePlanInput(input: JsonObject): readonly PlanItem[] | string {
    const rawPlan = input.plan;
    if (!Array.isArray(rawPlan)) {
      return "plan must be an array";
    }

    const items: PlanItem[] = [];
    for (let i = 0; i < rawPlan.length; i++) {
      const item = rawPlan[i] as Record<string, unknown> | undefined;
      if (item === undefined || typeof item !== "object" || item === null) {
        return `plan[${String(i)}] must be an object`;
      }
      if (typeof item.content !== "string" || item.content.length === 0) {
        return `plan[${String(i)}].content must be a non-empty string`;
      }
      if (typeof item.status !== "string" || !VALID_STATUSES.has(item.status)) {
        return `plan[${String(i)}].status must be one of: pending, in_progress, completed`;
      }
      items.push({ content: item.content, status: item.status as PlanStatus });
    }

    return items;
  }

  /** Format plan summary for tool response. */
  function formatPlanSummary(plan: readonly PlanItem[]): string {
    if (plan.length === 0) return "Plan cleared.";
    const pending = plan.filter((i) => i.status === "pending").length;
    const inProgress = plan.filter((i) => i.status === "in_progress").length;
    const completed = plan.filter((i) => i.status === "completed").length;
    return `Plan updated: ${String(plan.length)} items (${String(pending)} pending, ${String(inProgress)} in progress, ${String(completed)} completed)`;
  }

  return {
    name: "plan",
    priority,
    describeCapabilities: (_ctx: TurnContext): CapabilityFragment => ({
      label: "planning",
      description: `Planning mode: ${currentPlan.length > 0 ? "enabled" : "disabled"}`,
    }),

    async onBeforeTurn(_ctx: TurnContext): Promise<void> {
      writePlanCallsThisTurn = 0;
    },

    async wrapModelCall(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      const enriched = enrichRequest(request);
      const response = await next(enriched);

      // Attach current plan to response metadata for observability
      const metadata: JsonObject = {
        ...response.metadata,
        currentPlan: currentPlan as unknown as JsonObject,
      };
      return { ...response, metadata };
    },

    async *wrapModelStream(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      const enriched = enrichRequest(request);
      yield* next(enriched);
    },

    async wrapToolCall(
      _ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      // Pass through non-plan tool calls
      if (request.toolId !== WRITE_PLAN_TOOL_NAME) {
        return next(request);
      }

      // Enforce at-most-once per turn
      writePlanCallsThisTurn += 1;
      if (writePlanCallsThisTurn > 1) {
        return {
          output: { error: "write_plan can only be called once per response" },
          metadata: { planError: true },
        };
      }

      // Validate plan input
      const parsed = parsePlanInput(request.input);
      if (typeof parsed === "string") {
        return {
          output: { error: parsed },
          metadata: { planError: true },
        };
      }

      // Atomically replace the plan
      currentPlan = parsed;
      onPlanUpdate?.(currentPlan);

      return {
        output: formatPlanSummary(currentPlan),
        metadata: { currentPlan: currentPlan as unknown as JsonObject },
      };
    },
  };
}
