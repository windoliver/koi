/**
 * RLM middleware factory — intercepts rlm_process tool calls and runs
 * the REPL loop internally using the captured downstream model handler.
 *
 * Priority 300 (default): runs before model-router to inject the tool,
 * then intercepts the tool call before it reaches external dispatch.
 */

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
import { runCodeReplLoop } from "./code-repl-loop.js";
import { validateRlmConfig } from "./config.js";
import { runReplLoop } from "./repl-loop.js";
import { RLM_PROCESS_DESCRIPTOR, RLM_PROCESS_TOOL_NAME } from "./rlm-tool-descriptor.js";
import type { RlmMiddlewareConfig } from "./types.js";
import { DEFAULT_PRIORITY } from "./types.js";

/**
 * Creates an RLM middleware that injects `rlm_process` tool into model
 * requests and intercepts its calls to run the REPL loop.
 *
 * The captured `next` from `wrapModelCall` is used as the model handler
 * for the REPL loop's `llm_query` sub-calls, ensuring they go through
 * the downstream middleware chain (model-router, retry, etc.) but do
 * NOT re-enter the RLM middleware (no infinite recursion).
 */
export function createRlmMiddleware(config?: RlmMiddlewareConfig): KoiMiddleware {
  const validResult = validateRlmConfig(config);
  if (!validResult.ok) {
    throw new Error(validResult.error.message);
  }

  const validated = validResult.value;
  const priority = validated.priority ?? DEFAULT_PRIORITY;

  // Per-session captured model handlers — keyed by sessionId to prevent
  // concurrent turns from overwriting each other's handler.
  const capturedHandlers = new Map<string, ModelHandler>();

  const maxDepth = validated.maxDepth ?? 3;
  const currentDepth = validated.depth ?? 0;

  /** Enrich a model request by injecting the rlm_process tool descriptor. */
  function enrichRequest(request: ModelRequest): ModelRequest {
    // Strip rlm_process at max depth — structural enforcement (ypi pattern)
    if (currentDepth >= maxDepth) {
      return request;
    }
    const tools =
      request.tools !== undefined
        ? [...request.tools, RLM_PROCESS_DESCRIPTOR]
        : [RLM_PROCESS_DESCRIPTOR];
    return { ...request, tools };
  }

  return {
    name: "rlm",
    priority,

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      capturedHandlers.delete(ctx.sessionId as string);
    },

    describeCapabilities: (_ctx: TurnContext): CapabilityFragment => ({
      label: "rlm",
      description: "RLM: rlm_process tool injected for processing unbounded inputs",
    }),

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      capturedHandlers.set(ctx.session.sessionId as string, next);
      return next(enrichRequest(request));
    },

    async *wrapModelStream(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      // Cannot capture a ModelHandler from a streaming call — the stream handler
      // has a different signature. If rlm_process is invoked during a streaming
      // turn that never went through wrapModelCall, the tool call will return an
      // error asking to use non-streaming mode. We still inject the tool descriptor
      // so the model knows rlm_process exists.
      yield* next(enrichRequest(request));
    },

    async wrapToolCall(
      ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      // Pass through non-RLM tool calls
      if (request.toolId !== RLM_PROCESS_TOOL_NAME) {
        return next(request);
      }

      // Validate inputs
      const { input, question } = request.input;

      if (
        input === undefined ||
        input === null ||
        typeof input !== "string" ||
        input.length === 0
      ) {
        return {
          output: { error: "rlm_process requires a non-empty 'input' string", code: "RLM_ERROR" },
        };
      }

      if (
        question === undefined ||
        question === null ||
        typeof question !== "string" ||
        question.length === 0
      ) {
        return {
          output: {
            error: "rlm_process requires a non-empty 'question' string",
            code: "RLM_ERROR",
          },
        };
      }

      const capturedModelNext = capturedHandlers.get(ctx.session.sessionId as string);
      if (capturedModelNext === undefined) {
        return {
          output: {
            error:
              "RLM middleware has no captured model handler for this session — ensure wrapModelCall ran first (streaming turns cannot use rlm_process; use non-streaming mode)",
            code: "RLM_ERROR",
          },
        };
      }

      // Run the REPL loop — code-execution if scriptRunner present, tool-dispatch otherwise
      const result =
        validated.scriptRunner !== undefined
          ? await runCodeReplLoop({
              scriptRunner: validated.scriptRunner,
              modelCall: capturedModelNext,
              input,
              question,
              config: validated,
              signal: ctx.signal,
              onEvent: validated.onEvent,
            })
          : await runReplLoop({
              modelCall: capturedModelNext,
              input,
              question,
              config: validated,
              onEvent: validated.onEvent,
            });

      if (result.stopReason === "error") {
        return {
          output: { error: result.answer, code: "RLM_ERROR" },
          metadata: { rlmMetrics: result.metrics as unknown as Record<string, unknown> },
        };
      }

      return {
        output: result.answer,
        metadata: {
          rlmStopReason: result.stopReason,
          rlmMetrics: result.metrics as unknown as Record<string, unknown>,
        },
      };
    },
  };
}
