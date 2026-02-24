/**
 * Tracing middleware factory — bridges Koi middleware hooks to OpenTelemetry spans.
 *
 * Creates a span hierarchy: Session → Turn → Model Call / Model Stream / Tool Call.
 * Zero-cost when no TracerProvider is registered (OTel API returns noop spans).
 * Tracing errors are isolated — they never propagate to the application.
 */

import type {
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
import { context, type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import type { TracingConfig } from "./config.js";
import {
  GEN_AI_OPERATION_NAME,
  GEN_AI_REQUEST_MAX_TOKENS,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_REQUEST_TEMPERATURE,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  KOI_AGENT_ID,
  KOI_REQUEST_CONTENT,
  KOI_RESPONSE_CONTENT,
  KOI_SESSION_ID,
  KOI_TOOL_ID,
  KOI_TURN_INDEX,
} from "./semantic-conventions.js";
import { createSpanContextStore } from "./span-context.js";

const DEFAULT_SERVICE_NAME = "@koi/agent";

function sessionKey(ctx: SessionContext): string {
  return ctx.sessionId;
}

function turnKey(ctx: TurnContext): string {
  return `${ctx.session.sessionId}:${ctx.turnIndex}`;
}

function safeSerialize(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

export function createTracingMiddleware(config: TracingConfig = {}): KoiMiddleware {
  const tracer = config.tracer ?? trace.getTracer(config.serviceName ?? DEFAULT_SERVICE_NAME);
  const extraAttributes = config.attributes ?? {};
  const hasExtraAttributes = Object.keys(extraAttributes).length > 0;
  const captureContent = config.captureContent ?? false;
  const contentFilter = config.contentFilter;
  const onError = config.onError;

  const sessionSpans = createSpanContextStore();
  const turnSpans = createSpanContextStore();

  function startChildSpan(
    name: string,
    parentSpan: Span | undefined,
    attributes: Record<string, string | number>,
  ): Span {
    const parentCtx =
      parentSpan !== undefined ? trace.setSpan(context.active(), parentSpan) : context.active();

    const mergedAttrs = hasExtraAttributes ? { ...extraAttributes, ...attributes } : attributes;
    return tracer.startSpan(name, { attributes: mergedAttrs }, parentCtx);
  }

  function recordContent(span: Span, request: unknown, response: unknown): void {
    if (!captureContent || !span.isRecording()) {
      return;
    }

    try {
      const requestData = contentFilter ? contentFilter(request) : request;
      const responseData = contentFilter ? contentFilter(response) : response;

      span.setAttribute(KOI_REQUEST_CONTENT, safeSerialize(requestData));
      span.setAttribute(KOI_RESPONSE_CONTENT, safeSerialize(responseData));
    } catch (e: unknown) {
      onError?.(e);
    }
  }

  const middleware: KoiMiddleware = {
    name: "tracing",
    // 450: after audit@300, before event-trace@475, before default@500
    priority: 450,

    async onSessionStart(ctx: SessionContext): Promise<void> {
      try {
        const span = tracer.startSpan("koi.session", {
          attributes: {
            ...extraAttributes,
            [KOI_SESSION_ID]: ctx.sessionId,
            [KOI_AGENT_ID]: ctx.agentId,
          },
        });
        sessionSpans.set(sessionKey(ctx), span);
      } catch (e: unknown) {
        onError?.(e);
      }
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      try {
        const span = sessionSpans.get(sessionKey(ctx));
        if (span !== undefined) {
          span.end();
          sessionSpans.delete(sessionKey(ctx));
        }
      } catch (e: unknown) {
        onError?.(e);
      }
    },

    async onBeforeTurn(ctx: TurnContext): Promise<void> {
      try {
        const sessionSpan = sessionSpans.get(sessionKey(ctx.session));
        const span = startChildSpan("koi.turn", sessionSpan, {
          [KOI_SESSION_ID]: ctx.session.sessionId,
          [KOI_AGENT_ID]: ctx.session.agentId,
          [KOI_TURN_INDEX]: ctx.turnIndex,
        });
        turnSpans.set(turnKey(ctx), span);
      } catch (e: unknown) {
        onError?.(e);
      }
    },

    async onAfterTurn(ctx: TurnContext): Promise<void> {
      try {
        const span = turnSpans.get(turnKey(ctx));
        if (span !== undefined) {
          span.end();
          turnSpans.delete(turnKey(ctx));
        }
      } catch (e: unknown) {
        onError?.(e);
      }
    },

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      // let: assigned in try, used across try/catch/finally
      let span: Span | undefined;
      try {
        const turnSpan = turnSpans.get(turnKey(ctx));
        const attrs: Record<string, string | number> = {
          [GEN_AI_OPERATION_NAME]: "chat",
        };
        if (request.model !== undefined) {
          attrs[GEN_AI_REQUEST_MODEL] = request.model;
        }
        if (request.temperature !== undefined) {
          attrs[GEN_AI_REQUEST_TEMPERATURE] = request.temperature;
        }
        if (request.maxTokens !== undefined) {
          attrs[GEN_AI_REQUEST_MAX_TOKENS] = request.maxTokens;
        }
        span = startChildSpan("gen_ai.chat", turnSpan, attrs);
      } catch (e: unknown) {
        onError?.(e);
        return next(request);
      }

      try {
        const response = await next(request);
        if (span.isRecording()) {
          if (response.model !== undefined) {
            span.setAttribute(GEN_AI_RESPONSE_MODEL, response.model);
          }
          if (response.usage !== undefined) {
            span.setAttribute(GEN_AI_USAGE_INPUT_TOKENS, response.usage.inputTokens);
            span.setAttribute(GEN_AI_USAGE_OUTPUT_TOKENS, response.usage.outputTokens);
          }
          recordContent(span, request, response);
        }
        return response;
      } catch (e: unknown) {
        if (span.isRecording()) {
          span.recordException(e instanceof Error ? e : new Error(String(e)));
          span.setStatus({ code: SpanStatusCode.ERROR, message: String(e) });
        }
        throw e;
      } finally {
        span.end();
      }
    },

    async *wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      // let: assigned in try, used across try/catch/finally
      let span: Span | undefined;
      try {
        const turnSpan = turnSpans.get(turnKey(ctx));
        const attrs: Record<string, string | number> = {
          [GEN_AI_OPERATION_NAME]: "chat",
        };
        if (request.model !== undefined) {
          attrs[GEN_AI_REQUEST_MODEL] = request.model;
        }
        span = startChildSpan("gen_ai.stream", turnSpan, attrs);
      } catch (e: unknown) {
        onError?.(e);
        yield* next(request);
        return;
      }

      try {
        // let: accumulates the final response from the stream's done chunk
        let lastResponse: ModelResponse | undefined;
        for await (const chunk of next(request)) {
          if (chunk.kind === "done") {
            lastResponse = chunk.response;
          }
          yield chunk;
        }

        if (span.isRecording() && lastResponse !== undefined) {
          if (lastResponse.model !== undefined) {
            span.setAttribute(GEN_AI_RESPONSE_MODEL, lastResponse.model);
          }
          if (lastResponse.usage !== undefined) {
            span.setAttribute(GEN_AI_USAGE_INPUT_TOKENS, lastResponse.usage.inputTokens);
            span.setAttribute(GEN_AI_USAGE_OUTPUT_TOKENS, lastResponse.usage.outputTokens);
          }
          recordContent(span, request, lastResponse);
        }
      } catch (e: unknown) {
        if (span.isRecording()) {
          span.recordException(e instanceof Error ? e : new Error(String(e)));
          span.setStatus({ code: SpanStatusCode.ERROR, message: String(e) });
        }
        throw e;
      } finally {
        span.end();
      }
    },

    async wrapToolCall(
      ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      // let: assigned in try, used across try/catch/finally
      let span: Span | undefined;
      try {
        const turnSpan = turnSpans.get(turnKey(ctx));
        span = startChildSpan("koi.tool_call", turnSpan, {
          [KOI_TOOL_ID]: request.toolId,
        });
      } catch (e: unknown) {
        onError?.(e);
        return next(request);
      }

      try {
        const response = await next(request);
        recordContent(span, request, response);
        return response;
      } catch (e: unknown) {
        if (span.isRecording()) {
          span.recordException(e instanceof Error ? e : new Error(String(e)));
          span.setStatus({ code: SpanStatusCode.ERROR, message: String(e) });
        }
        throw e;
      } finally {
        span.end();
      }
    },
  };

  return middleware;
}
