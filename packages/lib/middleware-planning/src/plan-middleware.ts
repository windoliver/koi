/**
 * Planning middleware factory — inject write_plan tool for structured task tracking.
 *
 * Priority 450 (default): runs after tool-selector (420), before soul (500).
 */

import type {
  CapabilityFragment,
  InboundMessage,
  JsonObject,
  KoiMiddleware,
  ModelRequest,
  SessionId,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";
import { validatePlanConfig } from "./config.js";
import { PLAN_SYSTEM_PROMPT, WRITE_PLAN_DESCRIPTOR, WRITE_PLAN_TOOL_NAME } from "./plan-tool.js";
import type { PlanConfig, PlanItem, PlanStatus } from "./types.js";

const DEFAULT_PRIORITY = 450;
const VALID_STATUSES = new Set<string>(["pending", "in_progress", "completed"]);

const PLAN_SYSTEM_MESSAGE: InboundMessage = {
  senderId: "system:plan",
  timestamp: 0,
  content: [{ kind: "text", text: PLAN_SYSTEM_PROMPT }],
};

interface PlanSessionState {
  readonly currentPlan: readonly PlanItem[];
  readonly writePlanCallsThisTurn: number;
}

function renderPlanState(plan: readonly PlanItem[]): InboundMessage {
  const planText = plan
    .map((item, i) => `${String(i + 1)}. [${item.status}] ${item.content}`)
    .join("\n");
  return {
    senderId: "system:plan",
    timestamp: 0,
    content: [{ kind: "text", text: `Current plan state:\n${planText}` }],
  };
}

function enrichRequest(request: ModelRequest, currentPlan: readonly PlanItem[]): ModelRequest {
  const messages: readonly InboundMessage[] =
    currentPlan.length === 0
      ? [PLAN_SYSTEM_MESSAGE, ...request.messages]
      : [PLAN_SYSTEM_MESSAGE, renderPlanState(currentPlan), ...request.messages];
  const tools =
    request.tools !== undefined
      ? [...request.tools, WRITE_PLAN_DESCRIPTOR]
      : [WRITE_PLAN_DESCRIPTOR];
  return { ...request, messages, tools };
}

function parsePlanInput(input: JsonObject): readonly PlanItem[] | string {
  const rawPlan = input.plan;
  if (!Array.isArray(rawPlan)) return "plan must be an array";

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

function formatPlanSummary(plan: readonly PlanItem[]): string {
  if (plan.length === 0) return "Plan cleared.";
  const pending = plan.filter((i) => i.status === "pending").length;
  const inProgress = plan.filter((i) => i.status === "in_progress").length;
  const completed = plan.filter((i) => i.status === "completed").length;
  return `Plan updated: ${String(plan.length)} items (${String(pending)} pending, ${String(inProgress)} in progress, ${String(completed)} completed)`;
}

function capabilityFor(state: PlanSessionState | undefined): CapabilityFragment {
  if (state === undefined || state.currentPlan.length === 0) {
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
}

function errorResponse(message: string): ToolResponse {
  return { output: { error: message }, metadata: { planError: true } };
}

function handleWritePlan(
  sessions: Map<SessionId, PlanSessionState>,
  sessionId: SessionId,
  request: ToolRequest,
  onPlanUpdate: PlanConfig["onPlanUpdate"],
): ToolResponse {
  const state = sessions.get(sessionId);
  if (state === undefined) {
    return errorResponse("No active session for plan middleware");
  }

  const callCount = state.writePlanCallsThisTurn + 1;
  sessions.set(sessionId, { ...state, writePlanCallsThisTurn: callCount });
  if (callCount > 1) {
    return errorResponse("write_plan can only be called once per response");
  }

  const parsed = parsePlanInput(request.input);
  if (typeof parsed === "string") {
    return errorResponse(parsed);
  }

  sessions.set(sessionId, { currentPlan: parsed, writePlanCallsThisTurn: callCount });
  onPlanUpdate?.(parsed);

  return {
    output: formatPlanSummary(parsed),
    metadata: { currentPlan: parsed as unknown as JsonObject },
  };
}

function buildMiddleware(
  sessions: Map<SessionId, PlanSessionState>,
  onPlanUpdate: PlanConfig["onPlanUpdate"],
  priority: number,
): KoiMiddleware {
  return {
    name: "plan",
    priority,
    async onSessionStart(ctx) {
      sessions.set(ctx.sessionId, { currentPlan: [], writePlanCallsThisTurn: 0 });
    },
    async onSessionEnd(ctx) {
      sessions.delete(ctx.sessionId);
    },
    describeCapabilities: (ctx) => capabilityFor(sessions.get(ctx.session.sessionId)),
    async onBeforeTurn(ctx) {
      const state = sessions.get(ctx.session.sessionId);
      if (state !== undefined) {
        sessions.set(ctx.session.sessionId, { ...state, writePlanCallsThisTurn: 0 });
      }
    },
    async wrapModelCall(ctx, request, next) {
      const state = sessions.get(ctx.session.sessionId);
      const response = await next(enrichRequest(request, state?.currentPlan ?? []));
      const metadata: JsonObject = {
        ...response.metadata,
        currentPlan: (state?.currentPlan ?? []) as unknown as JsonObject,
      };
      return { ...response, metadata };
    },
    async *wrapModelStream(ctx, request, next) {
      const state = sessions.get(ctx.session.sessionId);
      yield* next(enrichRequest(request, state?.currentPlan ?? []));
    },
    async wrapToolCall(ctx, request, next) {
      if (request.toolId !== WRITE_PLAN_TOOL_NAME) return next(request);
      return handleWritePlan(sessions, ctx.session.sessionId, request, onPlanUpdate);
    },
  };
}

export function createPlanMiddleware(config?: PlanConfig): KoiMiddleware {
  const validated = validatePlanConfig(config);
  if (!validated.ok) {
    throw KoiRuntimeError.from(validated.error.code, validated.error.message);
  }
  const priority = validated.value.priority ?? DEFAULT_PRIORITY;
  return buildMiddleware(new Map(), validated.value.onPlanUpdate, priority);
}
