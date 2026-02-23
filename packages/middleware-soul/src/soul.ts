/**
 * Soul middleware factory — markdown-based agent character + user context injection.
 */

import type { InboundMessage } from "@koi/core/message";
import type {
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  TurnContext,
} from "@koi/core/middleware";
import type { CreateSoulOptions } from "./config.js";
import {
  DEFAULT_SOUL_MAX_TOKENS,
  DEFAULT_USER_MAX_TOKENS,
  extractInput,
  extractMaxTokens,
} from "./config.js";
import { resolveSoulContent, resolveUserContent } from "./resolve.js";

/**
 * Enriches a model request by prepending a soul system message.
 * Pure function — does not mutate the input request.
 */
export function enrichRequest(
  request: ModelRequest,
  soulMessage: InboundMessage | undefined,
): ModelRequest {
  if (soulMessage === undefined) return request;
  return { ...request, messages: [soulMessage, ...request.messages] };
}

function buildSoulMessage(soulText: string, userText: string): InboundMessage | undefined {
  const parts: string[] = [];
  if (soulText.length > 0) parts.push(soulText);
  if (userText.length > 0) parts.push(userText);

  if (parts.length === 0) return undefined;

  return {
    senderId: "system:soul",
    timestamp: Date.now(),
    content: [{ kind: "text", text: parts.join("\n\n") }],
  };
}

/**
 * Creates a soul middleware that injects agent personality and user context
 * into model calls as a system message prefix.
 *
 * Soul content is resolved once at factory time and cached.
 * User content is resolved once unless `refreshUser: true`, in which case
 * it is re-read on each model call.
 */
export async function createSoulMiddleware(options: CreateSoulOptions): Promise<KoiMiddleware> {
  const { basePath, refreshUser = false } = options;

  // Resolve soul content (cached for lifetime of middleware)
  let soulText = "";
  if (options.soul !== undefined) {
    const soulInput = extractInput(options.soul);
    const soulMaxTokens = extractMaxTokens(options.soul, DEFAULT_SOUL_MAX_TOKENS);
    const resolved = await resolveSoulContent({
      input: soulInput,
      maxTokens: soulMaxTokens,
      label: "soul",
      basePath,
    });
    soulText = resolved.text;
    for (const w of resolved.warnings) {
      console.warn(`[soul middleware] ${w}`);
    }
  }

  // Resolve user content (may be refreshed per-call)
  let userText = "";
  if (options.user !== undefined) {
    const userInput = extractInput(options.user);
    const userMaxTokens = extractMaxTokens(options.user, DEFAULT_USER_MAX_TOKENS);
    const resolved = await resolveUserContent({
      input: userInput,
      maxTokens: userMaxTokens,
      label: "user",
      basePath,
    });
    userText = resolved.text;
    for (const w of resolved.warnings) {
      console.warn(`[soul middleware] ${w}`);
    }
  }

  // Pre-build message for non-refresh case
  const cachedMessage = buildSoulMessage(soulText, userText);

  async function getSoulMessage(): Promise<InboundMessage | undefined> {
    if (!refreshUser || options.user === undefined) return cachedMessage;

    // Re-resolve user content
    const userInput = extractInput(options.user);
    const userMaxTokens = extractMaxTokens(options.user, DEFAULT_USER_MAX_TOKENS);
    const resolved = await resolveUserContent({
      input: userInput,
      maxTokens: userMaxTokens,
      label: "user",
      basePath,
    });
    return buildSoulMessage(soulText, resolved.text);
  }

  return {
    name: "soul",
    priority: 500,

    async wrapModelCall(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      const message = await getSoulMessage();
      return next(enrichRequest(request, message));
    },

    async *wrapModelStream(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<import("@koi/core/middleware").ModelChunk> {
      const message = await getSoulMessage();
      yield* next(enrichRequest(request, message));
    },
  };
}
