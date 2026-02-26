/**
 * Tool call limit middleware — caps tool calls per session with per-tool and global limits.
 *
 * Counts on attempt (before execution).
 * - "continue": returns a blocked ToolResponse instead of executing
 * - "end" / "error": throw RATE_LIMIT
 *
 * Priority 175: runs before pay (200) and compactor (225).
 */

import type {
  CapabilityFragment,
  KoiMiddleware,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core/middleware";
import { KoiRuntimeError } from "@koi/errors";
import type { ToolCallLimitConfig } from "./config.js";
import { createInMemoryCallLimitStore } from "./store.js";
import type { LimitReachedInfo } from "./types.js";

function toolStoreKey(sessionId: string, toolId: string): string {
  return `tool:${sessionId}:${toolId}`;
}

function globalStoreKey(sessionId: string): string {
  return `tool:${sessionId}:__global__`;
}

function createBlockedResponse(toolId: string, limit: number): ToolResponse {
  return {
    output: `Tool call blocked: ${toolId} exceeded limit of ${limit} calls`,
    metadata: { blocked: true, reason: "tool_call_limit_exceeded" },
  };
}

export function createToolCallLimitMiddleware(config: ToolCallLimitConfig): KoiMiddleware {
  const { limits, globalLimit, onLimitReached } = config;
  const store = config.store ?? createInMemoryCallLimitStore();
  const exitBehavior = config.exitBehavior ?? "continue";

  // Track unique {sessionId}:{toolId} keys where onLimitReached has fired
  const firedKeys = new Set<string>();

  function fireLimitReached(
    sessionId: string,
    toolId: string,
    count: number,
    currentLimit: number,
  ): void {
    if (!onLimitReached) return;
    const fireKey = `${sessionId}:${toolId}`;
    if (firedKeys.has(fireKey)) return;
    firedKeys.add(fireKey);
    const info: LimitReachedInfo = {
      kind: "tool",
      sessionId,
      count,
      limit: currentLimit,
      toolId,
    };
    onLimitReached(info);
  }

  function handleLimitExceeded(
    toolId: string,
    sessionId: string,
    count: number,
    currentLimit: number,
  ): ToolResponse {
    fireLimitReached(sessionId, toolId, count, currentLimit);

    if (exitBehavior === "continue") {
      return createBlockedResponse(toolId, currentLimit);
    }

    throw KoiRuntimeError.from(
      "RATE_LIMIT",
      `Tool call limit exceeded for '${toolId}' (${currentLimit}). Exit behavior: ${exitBehavior}`,
      {
        retryable: false,
        context: { toolId, limit: currentLimit, count, exitBehavior },
      },
    );
  }

  const capabilityFragment: CapabilityFragment = {
    label: "rate-limits",
    description: `Tool call limit: ${config.globalLimit ?? "per-tool"} calls per session`,
  };

  return {
    name: "koi:tool-call-limit",
    priority: 175,
    describeCapabilities: (_ctx: TurnContext): CapabilityFragment => capabilityFragment,

    async wrapToolCall(
      ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      const sessionId = ctx.session.sessionId;
      const toolId = request.toolId;

      // Check both limits before incrementing to avoid phantom counter drift.
      // Uses get() for read-only check, then increment() only after both pass.

      // Check global limit first
      if (globalLimit !== undefined) {
        const globalKey = globalStoreKey(sessionId);
        const currentGlobal = await store.get(globalKey);
        if (currentGlobal >= globalLimit) {
          return handleLimitExceeded(toolId, sessionId, currentGlobal + 1, globalLimit);
        }
      }

      // Check per-tool limit (only if defined for this specific tool)
      if (limits !== undefined) {
        const perToolLimit = limits[toolId];
        if (perToolLimit !== undefined) {
          const toolKey = toolStoreKey(sessionId, toolId);
          const currentTool = await store.get(toolKey);
          if (currentTool >= perToolLimit) {
            return handleLimitExceeded(toolId, sessionId, currentTool + 1, perToolLimit);
          }
        }
      }

      // Both checks passed — now increment counters
      if (globalLimit !== undefined) {
        await store.increment(globalStoreKey(sessionId));
      }
      if (limits !== undefined && limits[toolId] !== undefined) {
        await store.increment(toolStoreKey(sessionId, toolId));
      }

      return next(request);
    },
  };
}
