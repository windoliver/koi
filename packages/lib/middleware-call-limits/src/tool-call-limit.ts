/**
 * Tool call limit middleware — caps tool calls per session with per-tool and global limits.
 *
 * Increments BEFORE execution. Order: global first, then per-tool. If per-tool
 * is exceeded, the global increment is rolled back so a blocked call does not
 * consume global quota.
 *
 * exitBehavior:
 *   "continue" (default) — return a blocked ToolResponse with metadata.blocked=true
 *   "error"             — throw RATE_LIMIT KoiRuntimeError, aborting the turn
 */

import type {
  CapabilityFragment,
  KoiMiddleware,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";
import type { ToolCallLimitConfig } from "./config.js";
import { createInMemoryCallLimitStore } from "./store.js";
import type { CallLimitStore, LimitReachedInfo } from "./types.js";

function toolKey(sessionId: string, toolId: string): string {
  return `tool:${sessionId}:${toolId}`;
}

function globalKey(sessionId: string): string {
  return `tool:${sessionId}:__global__`;
}

function blockedResponse(toolId: string, limit: number): ToolResponse {
  return {
    output: `Tool call blocked: ${toolId} exceeded limit of ${String(limit)} calls`,
    metadata: { blocked: true, reason: "tool_call_limit_exceeded" },
  };
}

interface ToolLimitState {
  readonly config: ToolCallLimitConfig;
  readonly store: CallLimitStore;
  readonly exitBehavior: "continue" | "error";
  readonly fired: Set<string>;
  readonly capability: CapabilityFragment;
}

function fireToolLimit(s: ToolLimitState, info: LimitReachedInfo): void {
  const cb = s.config.onLimitReached;
  if (cb === undefined || info.kind !== "tool") return;
  const k = `${info.sessionId}:${info.toolId}`;
  if (s.fired.has(k)) return;
  s.fired.add(k);
  try {
    cb(info);
  } catch {
    // observer must not affect limit behavior
  }
}

function denyOrBlock(
  s: ToolLimitState,
  sessionId: string,
  toolId: string,
  count: number,
  limit: number,
): ToolResponse {
  fireToolLimit(s, { kind: "tool", sessionId, toolId, count, limit });
  if (s.exitBehavior === "continue") return blockedResponse(toolId, limit);
  throw KoiRuntimeError.from(
    "RATE_LIMIT",
    `Tool call limit exceeded for '${toolId}' (${String(limit)})`,
    { retryable: false, context: { toolId, limit, count } },
  );
}

async function tlWrapToolCall(
  s: ToolLimitState,
  ctx: TurnContext,
  request: ToolRequest,
  next: ToolHandler,
): Promise<ToolResponse> {
  const sessionId = ctx.session.sessionId;
  const toolId = request.toolId;
  const { globalLimit, limits } = s.config;

  if (globalLimit !== undefined) {
    const r = s.store.incrementIfBelow(globalKey(sessionId), globalLimit);
    if (!r.allowed) return denyOrBlock(s, sessionId, toolId, r.current + 1, globalLimit);
  }

  if (limits !== undefined) {
    const perTool = limits[toolId];
    if (perTool !== undefined) {
      const r = s.store.incrementIfBelow(toolKey(sessionId, toolId), perTool);
      if (!r.allowed) {
        if (globalLimit !== undefined) s.store.decrement(globalKey(sessionId));
        return denyOrBlock(s, sessionId, toolId, r.current + 1, perTool);
      }
    }
  }

  return next(request);
}

export function createToolCallLimitMiddleware(config: ToolCallLimitConfig): KoiMiddleware {
  const state: ToolLimitState = {
    config,
    store: config.store ?? createInMemoryCallLimitStore(),
    exitBehavior: config.exitBehavior ?? "continue",
    fired: new Set(),
    capability: {
      label: "rate-limits",
      description:
        config.globalLimit !== undefined
          ? `Tool calls capped: ${String(config.globalLimit)} per session`
          : "Tool calls capped: per-tool limits configured",
    },
  };
  return {
    name: "koi:tool-call-limit",
    priority: 175,
    phase: "intercept",
    wrapToolCall: (ctx, request, next) => tlWrapToolCall(state, ctx, request, next),
    describeCapabilities: () => state.capability,
  } satisfies KoiMiddleware;
}
