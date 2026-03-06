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
  SessionContext,
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

  interface PlanSessionState {
    readonly currentPlan: readonly PlanItem[];
    readonly writePlanCallsThisTurn: number;
  }

  const sessions = new Map<string, PlanSessionState>();

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

    async onSessionStart(ctx: SessionContext): Promise<void> {
      sessions.set(ctx.sessionId as string, {
        currentPlan: [],
        writePlanCallsThisTurn: 0,
      });
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      sessions.delete(ctx.sessionId as string);
    },

    describeCapabilities: (ctx: TurnContext): CapabilityFragment | undefined => {
      const state = sessions.get(ctx.session.sessionId as string);
      if (!state) {
        return {
          label: "planning",
          description: "Planning: write_plan tool injected, no active plan",
        };
      }
      if (state.currentPlan.length === 0) {
        return {
          label: "planning",
          description: "Planning: write_plan tool injected, no active plan",
        };
      }
      const pending = state.currentPlan.filter((i) => i.status === "pending").length;
      const inProgress = state.currentPlan.filter((i) => i.status === "in_progress").length;
      const completed = state.currentPlan.filter((i) => i.status === "completed").length;
      return {
        label: "planning",
        description: `Plan active: ${String(state.currentPlan.length)} items (${String(pending)} pending, ${String(inProgress)} in progress, ${String(completed)} completed)`,
      };
    },

    async onBeforeTurn(ctx: TurnContext): Promise<void> {
      const sessionId = ctx.session.sessionId as string;
      const state = sessions.get(sessionId);
      if (!state) return;
      sessions.set(sessionId, { ...state, writePlanCallsThisTurn: 0 });
    },

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      const state = sessions.get(ctx.session.sessionId as string);
      const enriched = enrichRequest(request);
      const response = await next(enriched);

      // Attach current plan to response metadata for observability
      const currentPlan = state?.currentPlan ?? [];
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
      ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      // Pass through non-plan tool calls
      if (request.toolId !== WRITE_PLAN_TOOL_NAME) {
        return next(request);
      }

      const sessionId = ctx.session.sessionId as string;
      const state = sessions.get(sessionId);
      if (!state) {
        return {
          output: { error: "No active session for plan middleware" },
          metadata: { planError: true },
        };
      }

      // Enforce at-most-once per turn
      const callCount = state.writePlanCallsThisTurn + 1;
      sessions.set(sessionId, { ...state, writePlanCallsThisTurn: callCount });
      if (callCount > 1) {
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
      sessions.set(sessionId, { currentPlan: parsed, writePlanCallsThisTurn: callCount });
      onPlanUpdate?.(parsed);

      return {
        output: formatPlanSummary(parsed),
        metadata: { currentPlan: parsed as unknown as JsonObject },
      };
    },
  };
}
