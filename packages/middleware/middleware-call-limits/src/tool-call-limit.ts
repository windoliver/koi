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

      // Atomic increment-if-below avoids TOCTOU races between concurrent calls.
      // Order: global first, then per-tool. If per-tool fails, rollback global.

      // Atomically check + increment global counter
      if (globalLimit !== undefined) {
        const globalKey = globalStoreKey(sessionId);
        const globalResult = await store.incrementIfBelow(globalKey, globalLimit);
        if (!globalResult.allowed) {
          return handleLimitExceeded(toolId, sessionId, globalResult.current + 1, globalLimit);
        }
      }

      // Atomically check + increment per-tool counter
      if (limits !== undefined) {
        const perToolLimit = limits[toolId];
        if (perToolLimit !== undefined) {
          const toolKey = toolStoreKey(sessionId, toolId);
          const toolResult = await store.incrementIfBelow(toolKey, perToolLimit);
          if (!toolResult.allowed) {
            // Rollback global increment so a blocked per-tool call does not consume global quota
            if (globalLimit !== undefined) {
              await store.decrement(globalStoreKey(sessionId));
            }
            return handleLimitExceeded(toolId, sessionId, toolResult.current + 1, perToolLimit);
          }
        }
      }

      return next(request);
    },
  };
}
