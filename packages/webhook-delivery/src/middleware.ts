/**
 * WebhookMiddleware — captures agent events and emits them to EventBackend.
 *
 * Fire-and-forget pattern (Decision #14): appends don't block the middleware chain.
 * Priority 900 — outer layer, runs after most middleware to capture final results.
 */

import type {
  EventBackend,
  KoiMiddleware,
  SessionContext,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";

export interface WebhookMiddlewareConfig {
  /** Stream name prefix for webhook events. Default: "webhook". */
  readonly streamPrefix?: string | undefined;
}

export interface WebhookMiddlewareLogger {
  readonly warn: (msg: string) => void;
}

/**
 * Creates a middleware that emits webhook events to an EventBackend stream.
 *
 * @param eventBackend - Event storage backend for webhook events
 * @param config - Optional stream prefix config
 * @param logger - Optional logger for fire-and-forget error reporting
 */
export function createWebhookMiddleware(
  eventBackend: EventBackend,
  config?: WebhookMiddlewareConfig,
  logger?: WebhookMiddlewareLogger,
): KoiMiddleware {
  const prefix = config?.streamPrefix ?? "webhook";

  function emitEvent(agentId: string, type: string, data: unknown): void {
    const streamId = `${prefix}:${agentId}`;
    void Promise.resolve(eventBackend.append(streamId, { type, data }))
      .then((result) => {
        if (!result.ok) {
          logger?.warn(`Webhook event append failed: ${result.error.message}`);
        }
      })
      .catch((err: unknown) => {
        logger?.warn(`Webhook event append threw: ${String(err)}`);
      });
  }

  return {
    name: "webhook",
    describeCapabilities: () => ({
      label: "webhook",
      description: "Webhook event delivery active",
    }),
    priority: 900,

    async onSessionStart(ctx: SessionContext): Promise<void> {
      emitEvent(ctx.agentId, "session.started", {
        sessionId: ctx.sessionId,
        runId: ctx.runId,
      });
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      emitEvent(ctx.agentId, "session.ended", {
        sessionId: ctx.sessionId,
        runId: ctx.runId,
      });
    },

    async wrapToolCall(
      ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      try {
        const response = await next(request);
        emitEvent(ctx.session.agentId, "tool.succeeded", {
          toolId: request.toolId,
          turnIndex: ctx.turnIndex,
        });
        return response;
      } catch (error: unknown) {
        emitEvent(ctx.session.agentId, "tool.failed", {
          toolId: request.toolId,
          turnIndex: ctx.turnIndex,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  };
}
