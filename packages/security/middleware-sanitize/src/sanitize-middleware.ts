/**
 * Sanitize middleware factory — content sanitization for model inputs,
 * model outputs, and tool I/O.
 *
 * Priority 350: runs after sandbox (200), compactor (225), context-editing (250),
 * but before memory (400) and default (500).
 */

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
import type { SanitizeMiddlewareConfig } from "./config.js";
import { DEFAULT_JSON_WALK_MAX_DEPTH, DEFAULT_STREAM_BUFFER_SIZE } from "./config.js";
import { resolvePresets } from "./rules.js";
import { sanitizeMessage, sanitizeString } from "./sanitize-block.js";
import { walkJsonStrings } from "./sanitize-json.js";
import { createStreamBuffer, mapBlockToStrip } from "./stream-buffer.js";
import type { SanitizationEvent, SanitizeRule } from "./types.js";

export function createSanitizeMiddleware(config: SanitizeMiddlewareConfig): KoiMiddleware {
  // 1. Resolve rules: merge config.rules + resolvePresets(config.presets)
  const presetRules = config.presets !== undefined ? resolvePresets(config.presets) : [];
  const allRules: readonly SanitizeRule[] = [...(config.rules ?? []), ...presetRules];

  const bufferSize = config.streamBufferSize ?? DEFAULT_STREAM_BUFFER_SIZE;
  // Pre-compute stream rules once (block→strip downgrade) instead of per-stream
  const streamRules = mapBlockToStrip(allRules);
  const sanitizeToolInput = config.sanitizeToolInput ?? true;
  const sanitizeToolOutput = config.sanitizeToolOutput ?? true;
  const maxDepth = config.jsonWalkMaxDepth ?? DEFAULT_JSON_WALK_MAX_DEPTH;
  const onSanitization = config.onSanitization;

  /** Sanitize all messages in a ModelRequest. Throws on block. */
  function sanitizeRequestMessages(request: ModelRequest): ModelRequest {
    // let justified: tracks whether any message was modified
    let anyChanged = false;
    const sanitizedMessages = request.messages.map((msg) => {
      const result = sanitizeMessage(msg, allRules, "input", onSanitization);
      if (result.blocked) {
        throw KoiRuntimeError.from("VALIDATION", "Content blocked by sanitization rule", {
          context: { location: "input" },
        });
      }
      if (result.events.length > 0) {
        anyChanged = true;
      }
      return result.message;
    });
    if (!anyChanged) return request;
    return { ...request, messages: sanitizedMessages };
  }

  const scopes: string[] = ["model input", "model output"];
  if (sanitizeToolInput) scopes.push("tool input");
  if (sanitizeToolOutput) scopes.push("tool output");
  const capabilityFragment: CapabilityFragment = {
    label: "sanitize",
    description: `Sanitization: ${String(allRules.length)} rules on ${scopes.join(", ")}`,
  };

  return {
    name: "sanitize",
    priority: 350,

    describeCapabilities: (_ctx: TurnContext) => capabilityFragment,

    async wrapModelCall(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      // INPUT: sanitize request messages
      const sanitizedRequest = sanitizeRequestMessages(request);

      // Call next
      const response = await next(sanitizedRequest);

      // OUTPUT: sanitize response content string
      const outputResult = sanitizeString(
        response.content,
        allRules,
        "output",
        "text",
        onSanitization,
      );

      if (outputResult.blocked) {
        throw KoiRuntimeError.from("VALIDATION", "Model output blocked by sanitization rule", {
          context: { location: "output" },
        });
      }

      if (outputResult.events.length === 0) {
        return response;
      }

      return { ...response, content: outputResult.text };
    },

    async *wrapModelStream(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      // INPUT: sanitize request messages
      const sanitizedRequest = sanitizeRequestMessages(request);

      // Separate buffers to avoid mixing text and thinking content
      const textBuf = createStreamBuffer(streamRules, bufferSize);
      const thinkBuf = createStreamBuffer(streamRules, bufferSize);

      for await (const chunk of next(sanitizedRequest)) {
        switch (chunk.kind) {
          case "text_delta": {
            const result = textBuf.push(chunk.delta);
            if (result.safe.length > 0) {
              yield { kind: "text_delta", delta: result.safe };
            }
            for (const event of result.events) {
              onSanitization?.(event);
            }
            break;
          }
          case "thinking_delta": {
            const result = thinkBuf.push(chunk.delta);
            if (result.safe.length > 0) {
              yield { kind: "thinking_delta", delta: result.safe };
            }
            for (const event of result.events) {
              onSanitization?.(event);
            }
            break;
          }
          case "done": {
            // Flush both buffers with correct chunk kinds
            const flushedText = textBuf.flush();
            if (flushedText.safe.length > 0) {
              yield { kind: "text_delta", delta: flushedText.safe };
            }
            for (const event of flushedText.events) {
              onSanitization?.(event);
            }
            const flushedThink = thinkBuf.flush();
            if (flushedThink.safe.length > 0) {
              yield { kind: "thinking_delta", delta: flushedThink.safe };
            }
            for (const event of flushedThink.events) {
              onSanitization?.(event);
            }

            // Sanitize the final ModelResponse content
            const sanitizedContent = sanitizeString(
              chunk.response.content,
              allRules,
              "output",
              "text",
              onSanitization,
            );
            // Block action downgraded — we already yielded partial content
            const sanitizedResponse: ModelResponse =
              sanitizedContent.events.length > 0
                ? { ...chunk.response, content: sanitizedContent.text }
                : chunk.response;

            yield { kind: "done", response: sanitizedResponse };
            break;
          }
          default: {
            // tool_call_start, tool_call_delta, tool_call_end, usage — pass through
            yield chunk;
          }
        }
      }
    },

    async wrapToolCall(
      _ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      // INPUT: sanitize tool input
      const sanitizedRequest = sanitizeToolInput
        ? sanitizeToolInputFn(request, allRules, maxDepth, onSanitization)
        : request;

      // Call next
      const response = await next(sanitizedRequest);

      // OUTPUT: sanitize tool output
      if (!sanitizeToolOutput) {
        return response;
      }

      const outputResult = walkJsonStrings(
        response.output,
        allRules,
        "tool-output",
        onSanitization,
        maxDepth,
      );

      if (outputResult.blocked) {
        throw KoiRuntimeError.from(
          "VALIDATION",
          `Tool "${request.toolId}" output blocked by sanitization rule`,
          { context: { toolId: request.toolId, location: "tool-output" } },
        );
      }

      if (outputResult.events.length === 0) {
        return response;
      }

      return { ...response, output: outputResult.value };
    },
  };
}

/** Sanitize a ToolRequest's input fields. Throws on block. */
function sanitizeToolInputFn(
  request: ToolRequest,
  rules: readonly SanitizeRule[],
  maxDepth: number,
  onSanitization: ((event: SanitizationEvent) => void) | undefined,
): ToolRequest {
  const inputResult = walkJsonStrings(request.input, rules, "tool-input", onSanitization, maxDepth);

  if (inputResult.blocked) {
    throw KoiRuntimeError.from(
      "VALIDATION",
      `Tool "${request.toolId}" input blocked by sanitization rule`,
      { context: { toolId: request.toolId, location: "tool-input" } },
    );
  }

  if (inputResult.events.length === 0) {
    return request;
  }

  // Cast justified: walkJsonStrings preserves object structure — only string leaves change.
  // The returned value has the same shape as JsonObject but is typed as `unknown`.
  return { ...request, input: inputResult.value as typeof request.input };
}
