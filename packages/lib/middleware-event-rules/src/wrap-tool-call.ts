/**
 * `wrapToolCall` implementation for the event-rules middleware.
 * Extracted from rule-middleware.ts to keep individual functions and
 * files under the project's complexity budget.
 */

import type { ToolHandler, ToolRequest, ToolResponse, TurnContext } from "@koi/core";
import { runBounded } from "./actions.js";
import { classifyResponse, emitDenialLog, FALLBACK_DENY_LOGGER, flattenInput } from "./helpers.js";
import type { MiddlewareState } from "./rule-middleware.js";
import type { RuleEvent } from "./types.js";

function buildBlockedResponse(toolId: string): ToolResponse {
  return {
    output: `Tool '${toolId}' is blocked by event rules`,
    metadata: {
      // `blocked: true` is the canonical denial sentinel (matches
      // call-limits/peer middleware). `blockedByHook: true` is also
      // set so downstream classifiers that key only off the hook flag
      // (semantic-retry's isBlockedToolResponse, event-trace's failure
      // marking) treat event-rules denials as policy denials.
      blocked: true,
      blockedByHook: true,
      error: true,
      reason: "event_rules_skip",
    },
  };
}

function fireOnBlock(state: MiddlewareState, request: ToolRequest, sessionId: string): void {
  const cb = state.actionContext.onBlock;
  if (cb === undefined) return;
  // Fire-and-forget BUT TRACKED: the deny path must not wait on
  // onBlock (a slow audit/paging callback would amplify each blocked
  // retry into latency), but we keep a handle so onSessionEnd can
  // drain pending audit hooks before resetting state.
  const pending = runBounded(
    (signal: AbortSignal): Promise<void> =>
      Promise.resolve(
        cb(
          {
            toolId: request.toolId,
            sessionId,
            reason: "event_rules_skip",
          },
          signal,
        ),
      ).then((): undefined => undefined),
    "event-rules:deny",
    "onBlock",
    state.actionContext.logger ?? FALLBACK_DENY_LOGGER,
  );
  state.trackPending(sessionId as never, pending);
}

async function wrapToolCallImpl(
  state: MiddlewareState,
  ctx: TurnContext,
  request: ToolRequest,
  next: ToolHandler,
): Promise<ToolResponse> {
  const sessionId = ctx.session.sessionId;
  if (state.closedSessions.has(sessionId)) {
    return next(request);
  }
  const skipSet = state.getSkipSet(sessionId);
  const engine = state.getOrCreateEngine(sessionId);

  const contextFields: Readonly<Record<string, unknown>> = {
    agentId: ctx.session.agentId,
    sessionId,
    turnIndex: ctx.turnIndex,
  };

  // Pre-call: peek unconditional rules so an input-bearing rule
  // blocks the FIRST destructive call before `next()` runs. peekRule
  // returns only skip directives — side-effecting actions are NOT
  // fired pre-call so templated messages cannot exfiltrate
  // unsanitized arguments.
  const preEvent: RuleEvent = {
    type: "tool_call",
    sessionId,
    fields: { ...flattenInput(request.input), ...contextFields, toolId: request.toolId },
  };
  const peeked = engine.peekRule(preEvent);
  state.applySkips(skipSet, peeked.skips);

  if (state.isBlocked(skipSet, request.toolId)) {
    emitDenialLog(request.toolId, String(sessionId), state.actionContext.logger);
    fireOnBlock(state, request, String(sessionId));
    return buildBlockedResponse(request.toolId);
  }

  // let justified: try/catch capture
  let response: ToolResponse;
  try {
    response = await next(request);
  } catch (error: unknown) {
    // Throws are real execution failures — set blocked/blockedByHook
    // false explicitly so the documented denial-isolation matcher
    // fires (exact-match distinguishes false from undefined).
    const failureEvent: RuleEvent = {
      type: "tool_call",
      sessionId,
      fields: {
        ...flattenInput(request.input),
        ...contextFields,
        toolId: request.toolId,
        ok: false,
        blocked: false,
        blockedByHook: false,
      },
    };
    state.evaluateAndExecute(failureEvent, state.actionContext, skipSet);
    throw error;
  }

  const { ok, blocked, blockedByHook, reason } = classifyResponse(response);
  const event: RuleEvent = {
    type: "tool_call",
    sessionId,
    fields: {
      ...flattenInput(request.input),
      ...contextFields,
      toolId: request.toolId,
      ok,
      blocked,
      blockedByHook,
      ...(reason !== undefined ? { reason } : {}),
    },
  };
  state.evaluateAndExecute(event, state.actionContext, skipSet);
  return response;
}

export function createWrapToolCall(
  state: MiddlewareState,
): (ctx: TurnContext, request: ToolRequest, next: ToolHandler) => Promise<ToolResponse> {
  return (ctx, request, next): Promise<ToolResponse> => wrapToolCallImpl(state, ctx, request, next);
}
