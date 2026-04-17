/**
 * Planning middleware factory — inject write_plan tool for structured task tracking.
 *
 * Priority 450 (default): runs after tool-selector (420), before soul (500).
 *
 * Concurrency model: the once-per-response quota is keyed by `TurnId` (not
 * session). Overlapping turns on the same session cannot reset each other's
 * counter. Plan commits use `turnIndex` monotonicity — a stale turn that
 * finishes after a newer turn has already committed its plan is rejected
 * rather than overwriting.
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
  TurnId,
} from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";
import { validatePlanConfig } from "./config.js";
import { PLAN_SYSTEM_PROMPT, WRITE_PLAN_DESCRIPTOR, WRITE_PLAN_TOOL_NAME } from "./plan-tool.js";
import type { PlanConfig, PlanItem, PlanStatus } from "./types.js";

const DEFAULT_PRIORITY = 450;
const VALID_STATUSES = new Set<string>(["pending", "in_progress", "completed"]);

/**
 * Input caps. `write_plan` replays the full rendered plan into every
 * subsequent model request; without these, a single oversized write
 * permanently inflates prompts for the rest of the session.
 */
const MAX_PLAN_ITEMS = 100;
const MAX_CONTENT_LENGTH = 2000;

const PLAN_SYSTEM_MESSAGE: InboundMessage = {
  senderId: "system:plan",
  timestamp: 0,
  content: [{ kind: "text", text: PLAN_SYSTEM_PROMPT }],
};

interface PlanSessionState {
  readonly currentPlan: readonly PlanItem[];
  /** turnIndex of the turn that last committed the plan. -1 = never committed. */
  readonly lastUpdateTurnIndex: number;
  /** Per-turn write counts — fresh turnId means fresh quota. */
  readonly perTurnWriteCounts: Map<TurnId, number>;
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
  if (rawPlan.length > MAX_PLAN_ITEMS) {
    return `plan has ${String(rawPlan.length)} items; limit is ${String(MAX_PLAN_ITEMS)}`;
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
    if (item.content.length > MAX_CONTENT_LENGTH) {
      return `plan[${String(i)}].content exceeds ${String(MAX_CONTENT_LENGTH)} characters`;
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

/**
 * Invoke the observability callback without letting its failures leak
 * into the tool response. The plan has already been committed; the
 * caller should still see success so it doesn't retry and produce
 * inconsistent state.
 */
function invokeOnPlanUpdate(
  onPlanUpdate: PlanConfig["onPlanUpdate"],
  plan: readonly PlanItem[],
): void {
  if (onPlanUpdate === undefined) return;
  try {
    onPlanUpdate(plan);
  } catch {
    // Observability callback; failures must not affect correctness.
  }
}

function handleWritePlan(
  sessions: Map<SessionId, PlanSessionState>,
  sessionId: SessionId,
  turnIdForQuota: TurnId,
  turnIndex: number,
  request: ToolRequest,
  onPlanUpdate: PlanConfig["onPlanUpdate"],
): ToolResponse {
  const state = sessions.get(sessionId);
  if (state === undefined) {
    return errorResponse("No active session for plan middleware");
  }

  // Per-turn quota — overlapping turns each get their own counter.
  const priorCount = state.perTurnWriteCounts.get(turnIdForQuota) ?? 0;
  const callCount = priorCount + 1;
  state.perTurnWriteCounts.set(turnIdForQuota, callCount);
  if (callCount > 1) {
    return errorResponse("write_plan can only be called once per response");
  }

  const parsed = parsePlanInput(request.input);
  if (typeof parsed === "string") {
    return errorResponse(parsed);
  }

  // Stale-turn protection — reject writes from turns older than the one
  // that already committed the current plan. A later turn's commit wins.
  if (turnIndex < state.lastUpdateTurnIndex) {
    return errorResponse("plan already updated by a newer turn; write rejected as stale");
  }

  sessions.set(sessionId, {
    currentPlan: parsed,
    lastUpdateTurnIndex: turnIndex,
    perTurnWriteCounts: state.perTurnWriteCounts,
  });
  invokeOnPlanUpdate(onPlanUpdate, parsed);

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
      sessions.set(ctx.sessionId, {
        currentPlan: [],
        lastUpdateTurnIndex: -1,
        perTurnWriteCounts: new Map(),
      });
    },
    async onSessionEnd(ctx) {
      sessions.delete(ctx.sessionId);
    },
    describeCapabilities: (ctx) => capabilityFor(sessions.get(ctx.session.sessionId)),
    async onAfterTurn(ctx) {
      sessions.get(ctx.session.sessionId)?.perTurnWriteCounts.delete(ctx.turnId);
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
      return handleWritePlan(
        sessions,
        ctx.session.sessionId,
        ctx.turnId,
        ctx.turnIndex,
        request,
        onPlanUpdate,
      );
    },
  };
}

export { MAX_CONTENT_LENGTH, MAX_PLAN_ITEMS };

export function createPlanMiddleware(config?: PlanConfig): KoiMiddleware {
  const validated = validatePlanConfig(config);
  if (!validated.ok) {
    throw KoiRuntimeError.from(validated.error.code, validated.error.message);
  }
  const priority = validated.value.priority ?? DEFAULT_PRIORITY;
  return buildMiddleware(new Map(), validated.value.onPlanUpdate, priority);
}
