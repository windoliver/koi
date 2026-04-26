/**
 * Tool-recovery middleware factory — recovers structured tool calls from text
 * patterns in model responses (Hermes, Llama 3.1, JSON fence, custom).
 *
 * Phase: `resolve` (the default tier). The middleware does NOT mutate the
 * outgoing request — it inspects the `ModelResponse` returned by `next()` and
 * rewrites `response.content` + `response.metadata.toolCalls` so downstream
 * middleware (sanitize / PII / audit) sees clean structured data.
 *
 * Priority 180: low number = outer onion layer. Recovery wraps from outside
 * so its rewrite is visible to every middleware that runs after it (higher
 * priority numbers). Streaming (`wrapModelStream`) is intentionally out of
 * scope for Phase 1 — the doc spec leaves a buffer/flush state machine for
 * Phase 2.
 */

import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  TurnContext,
} from "@koi/core/middleware";
import { KoiRuntimeError } from "@koi/errors";
import type { ToolRecoveryConfig } from "./config.js";
import {
  DEFAULT_MAX_TOOL_CALLS,
  DEFAULT_PATTERN_NAMES,
  validateToolRecoveryConfig,
} from "./config.js";
import { recoverToolCalls } from "./parse.js";
import { resolvePatterns } from "./patterns/registry.js";
import type { ParsedToolCall, ToolCallPattern } from "./types.js";

/** Priority slot — outer onion layer; runs before sanitize/PII/audit. */
const TOOL_RECOVERY_PRIORITY = 180;

interface RecoveredCall {
  readonly toolName: string;
  readonly callId: string;
  readonly input: ParsedToolCall["arguments"];
}

/**
 * Creates a `KoiMiddleware` that recovers structured tool calls from text
 * patterns in model responses. See `ToolRecoveryConfig` for options.
 */
export function createToolRecoveryMiddleware(config?: ToolRecoveryConfig): KoiMiddleware {
  const validated = validateToolRecoveryConfig(config);
  if (!validated.ok) {
    throw KoiRuntimeError.from(validated.error.code, validated.error.message);
  }

  const cfg = validated.value;
  const patternEntries = cfg.patterns ?? DEFAULT_PATTERN_NAMES;
  const patterns: readonly ToolCallPattern[] = resolvePatterns(patternEntries);
  const maxCalls = cfg.maxToolCallsPerResponse ?? DEFAULT_MAX_TOOL_CALLS;
  const onEvent = cfg.onRecoveryEvent;

  const patternNames = patterns.map((p) => p.name).join(", ");
  const capabilityFragment: CapabilityFragment = {
    label: "tool-recovery",
    description: `Text tool-call recovery: ${patternNames}`,
  };

  function rewriteResponse(
    ctx: TurnContext,
    request: ModelRequest,
    response: ModelResponse,
  ): ModelResponse {
    // Short-circuit: native tool calls already present.
    if (response.metadata !== undefined && response.metadata.toolCalls !== undefined) {
      return response;
    }
    const tools = request.tools;
    if (tools === undefined || tools.length === 0) return response;

    const allowed = new Set<string>(tools.map((t) => t.name));
    const result = recoverToolCalls(response.content, patterns, allowed, maxCalls, onEvent);
    if (result === undefined) return response;

    const toolCalls: readonly RecoveredCall[] = result.toolCalls.map((call, index) => ({
      toolName: call.toolName,
      callId: `recovery-${ctx.turnId}-${String(index)}`,
      input: call.arguments,
    }));

    return {
      ...response,
      content: result.remainingText,
      metadata: { ...response.metadata, toolCalls },
    };
  }

  return {
    name: "koi:tool-recovery",
    priority: TOOL_RECOVERY_PRIORITY,
    phase: "resolve",
    describeCapabilities: (_ctx: TurnContext): CapabilityFragment => capabilityFragment,
    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      // Cheap pre-check: skip the recovery path entirely when no tools are
      // available — saves an allocation + Set construction on the hot path.
      if (request.tools === undefined || request.tools.length === 0) {
        return next(request);
      }
      const response = await next(request);
      return rewriteResponse(ctx, request, response);
    },
  };
}
