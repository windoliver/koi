/**
 * Memory middleware factory — persistent memory injection.
 */

import type { InboundMessage } from "@koi/core/message";
import type {
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  TurnContext,
} from "@koi/core/middleware";
import { swallowError } from "@koi/errors";
import type { MemoryMiddlewareConfig } from "./config.js";

const DEFAULT_MAX_RECALL_TOKENS = 4000;

function extractLastMessageText(messages: readonly InboundMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg) {
      for (const block of msg.content) {
        if (block.kind === "text") {
          return block.text;
        }
      }
    }
  }
  return "";
}

export function createMemoryMiddleware(config: MemoryMiddlewareConfig): KoiMiddleware {
  const {
    store,
    maxRecallTokens = DEFAULT_MAX_RECALL_TOKENS,
    storeResponses = true,
    onStoreError,
  } = config;

  return {
    name: "memory",
    priority: 400,

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      // Recall memories based on the last message text
      const query = extractLastMessageText(request.messages);
      const memories = await store.recall(query, maxRecallTokens);

      let enrichedRequest: ModelRequest;
      if (memories.length > 0) {
        const memoryText = memories.map((m) => m.content).join("\n---\n");

        const memoryMessage: InboundMessage = {
          senderId: "system:memory",
          timestamp: Date.now(),
          content: [
            {
              kind: "text",
              text: `[Memory Context]\n${memoryText}`,
            },
          ],
        };

        enrichedRequest = {
          ...request,
          messages: [memoryMessage, ...request.messages],
        };
      } else {
        enrichedRequest = request;
      }

      const response = await next(enrichedRequest);

      // Store the exchange for future recall
      if (storeResponses && response.content) {
        try {
          await store.store(ctx.session.sessionId, response.content, {
            turnIndex: ctx.turnIndex,
            model: response.model,
          });
        } catch (error: unknown) {
          if (onStoreError) {
            onStoreError(error);
          } else {
            swallowError(error, { package: "middleware-memory", operation: "store" });
          }
        }
      }

      return response;
    },
  };
}
