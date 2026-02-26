/**
 * createGoalAnchorMiddleware — Manus-style todo-anchored attention management.
 *
 * Injects a live todo list as a system message at the start of every model call,
 * keeping declared objectives in the model's recent attention span.
 * Heuristically marks objectives complete when model responses mention them.
 */

import type { InboundMessage } from "@koi/core/message";
import type {
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  SessionContext,
  TurnContext,
} from "@koi/core/middleware";
import type { GoalAnchorConfig } from "./config.js";
import { createTodoState, detectCompletions, renderTodoBlock } from "./todo.js";
import type { TodoItem, TodoState } from "./types.js";

export function createGoalAnchorMiddleware(config: GoalAnchorConfig): KoiMiddleware {
  if (config.objectives.length === 0) {
    // No-op middleware when objectives are empty
    return { name: "goal-anchor", priority: 340 };
  }

  const header = config.header ?? "## Current Objectives";
  const sessions = new Map<string, TodoState>();

  return {
    name: "goal-anchor",
    priority: 340,

    async onSessionStart(ctx: SessionContext): Promise<void> {
      sessions.set(ctx.sessionId as string, createTodoState(config.objectives));
    },

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      const state = sessions.get(ctx.session.sessionId as string);
      if (!state) return next(request);

      const enriched = enrichRequest(request, buildGoalMessage(renderTodoBlock(state, header)));
      const response = await next(enriched);

      // ModelResponse.content is a string — use directly for completion detection
      const responseText = response.content;
      if (responseText.length > 0) {
        const updated = detectCompletions(responseText, state);
        if (updated !== state) {
          sessions.set(ctx.session.sessionId as string, updated);
          notifyCompletions(state, updated, config.onComplete);
        }
      }

      return response;
    },

    async *wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      const state = sessions.get(ctx.session.sessionId as string);
      if (!state) {
        yield* next(request);
        return;
      }

      const enriched = enrichRequest(request, buildGoalMessage(renderTodoBlock(state, header)));

      let bufferedText = "";
      try {
        for await (const chunk of next(enriched)) {
          // ModelChunk uses "text_delta" with a "delta" field for streaming text
          if (chunk.kind === "text_delta") bufferedText += chunk.delta;
          yield chunk;
        }
      } finally {
        // Run completion detection regardless of how stream ended
        if (bufferedText.length > 0) {
          const updated = detectCompletions(bufferedText, state);
          if (updated !== state) {
            sessions.set(ctx.session.sessionId as string, updated);
            notifyCompletions(state, updated, config.onComplete);
          }
        }
      }
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      sessions.delete(ctx.sessionId as string);
    },
  };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function buildGoalMessage(text: string): InboundMessage {
  return {
    senderId: "system:goal-anchor",
    timestamp: Date.now(),
    content: [{ kind: "text", text }],
  };
}

function enrichRequest(request: ModelRequest, msg: InboundMessage): ModelRequest {
  return { ...request, messages: [msg, ...request.messages] };
}

function notifyCompletions(
  prev: TodoState,
  next: TodoState,
  cb: ((item: TodoItem) => void) | undefined,
): void {
  if (!cb) return;
  for (let i = 0; i < next.items.length; i++) {
    const prevItem = prev.items[i];
    const nextItem = next.items[i];
    if (
      prevItem !== undefined &&
      nextItem !== undefined &&
      prevItem.status !== "completed" &&
      nextItem.status === "completed"
    ) {
      cb(nextItem);
    }
  }
}
