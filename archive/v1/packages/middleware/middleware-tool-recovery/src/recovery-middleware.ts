/**
 * Tool recovery middleware factory — recovers structured tool calls
 * from text patterns in model responses.
 *
 * Priority 180: runs as outer layer so downstream middleware (sanitize,
 * PII, audit) sees clean structured data.
 */

import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  TurnContext,
} from "@koi/core/middleware";
import type { ToolRecoveryConfig } from "./config.js";
import { DEFAULT_MAX_TOOL_CALLS, DEFAULT_PATTERN_NAMES } from "./config.js";
import { recoverToolCalls } from "./parse.js";
import { resolvePatterns } from "./patterns/registry.js";
import type { ToolCallPattern } from "./types.js";

export function createToolRecoveryMiddleware(config?: ToolRecoveryConfig): KoiMiddleware {
  const patternEntries = config?.patterns ?? DEFAULT_PATTERN_NAMES;
  const patterns: readonly ToolCallPattern[] = resolvePatterns(patternEntries);
  const maxCalls = config?.maxToolCallsPerResponse ?? DEFAULT_MAX_TOOL_CALLS;
  const onEvent = config?.onRecoveryEvent;

  const patternNames = patterns.map((p) => p.name).join(", ");
  const capabilityFragment: CapabilityFragment = {
    label: "tool-recovery",
    description: `Text tool-call recovery: ${patternNames}`,
  };

  return {
    name: "tool-recovery",
    priority: 180,

    describeCapabilities: (_ctx: TurnContext) => capabilityFragment,

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      // Short-circuit: no tools available → nothing to recover
      if (request.tools === undefined || request.tools.length === 0) {
        return next(request);
      }

      const response = await next(request);

      // Short-circuit: response already has tool calls in metadata
      if (response.metadata !== undefined && response.metadata.toolCalls !== undefined) {
        return response;
      }

      // Build allowed tools set from request descriptors
      const allowedTools = new Set(request.tools.map((t) => t.name));

      const result = recoverToolCalls(response.content, patterns, allowedTools, maxCalls, onEvent);

      if (result === undefined) return response;

      // Generate deterministic IDs: recovery-{turnId}-{index}
      const toolCalls = result.toolCalls.map((call, index) => ({
        toolName: call.toolName,
        callId: `recovery-${ctx.turnId}-${String(index)}`,
        input: call.arguments,
      }));

      return {
        ...response,
        content: result.remainingText,
        metadata: {
          ...response.metadata,
          toolCalls,
        },
      };
    },
  };
}
